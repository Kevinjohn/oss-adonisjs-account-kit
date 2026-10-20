import { lockUser, transaction, isUserEmailUniqueViolation } from './db.js'
import { revision } from './authentication.js'
import { finishCommitted, settleCommitted } from './effects.js'
import { isEmailShaped } from './email.js'
import { createHandoff, redeemSocialHandoff } from './social_handoff.js'
import { consumeSocialSensitiveProof, proveSocialPassword } from './social_proofs.js'
import {
  SocialEmailMissingError,
  SocialIdentityAlreadyLinkedError,
  SocialProofError,
  SocialTransactionError,
  SocialUserNotFoundError,
} from './errors.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import {
  checkedProfile,
  consumeState,
  createAccount,
  isIdentityConflict,
  provider,
  socialCallback,
} from './social_callback.js'
import { listSocialIdentities, unlinkSocialIdentity } from './social_links.js'
import { authenticated, enabledProviders, expiry, now, type Dependencies } from './social_shared.js'
import { isSensitivePurpose, isSocialBeginIntent } from './social_enums.js'
import { sendVerification } from './verification.js'
import type {
  AuthenticationGuard,
  CurrentAccount,
  CurrentAccountInput,
  SensitivePurpose,
  SocialBeginInput,
  SocialCallbackInput,
  SocialCallbackResult,
  SocialIdentity,
  SocialProviderName,
  Trx,
  UserId,
} from './types.js'

const validChallenge = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

export { consumeSocialSensitiveProof }

export function socialIdentityService(deps: Dependencies) {
  return {
    /** Starts a provider flow and returns the one-use state and the provider URL to redirect to. */
    async begin(input: SocialBeginInput): Promise<{ state: string; url: string }> {
      const adapter = provider(deps, input.provider)
      if (!validChallenge(input.clientChallenge)) throw new SocialTransactionError()
      if (!isSocialBeginIntent(input.intent)) throw new SocialTransactionError()
      if (input.proof !== undefined && (input.intent !== 'link' || !isTokenShaped(input.proof)))
        throw new SocialProofError()
      if (input.intent === 'reauth' && !isSensitivePurpose(input.purpose))
        throw new SocialTransactionError()
      if (input.intent === 'reauth' && !adapter.verifyFreshAuthentication)
        throw new SocialProofError()
      const state = generateToken()
      await transaction(deps.db, async (trx) => {
        const user = input.intent === 'login' ? null : await authenticated(deps, input.current, trx)
        await trx.table('social_transactions').insert({
          hash: hashToken(state),
          provider: input.provider,
          intent: input.intent,
          purpose: input.intent === 'reauth' ? input.purpose : null,
          client_challenge: input.clientChallenge,
          user_id: user?.id ?? null,
          proof_hash: input.proof ? hashToken(input.proof) : null,
          credential_revision:
            input.intent === 'reauth' && user ? await revision(trx, deps.config, user.id) : null,
          expires_at: expiry(trx),
          created_at: now(trx),
        })
      })
      return { state, url: await adapter.authorizationUrl(state, input.context) }
    },

    /**
     * Starts the fresh provider callback that confirms a pending identity, bound to its email
     * verification proof.
     */
    async beginConfirmation(input: {
      provider: SocialProviderName
      verificationToken: string
      clientChallenge: string
      context?: unknown
    }): Promise<{ state: string; url: string }> {
      const adapter = provider(deps, input.provider)
      if (!validChallenge(input.clientChallenge) || !isTokenShaped(input.verificationToken))
        throw new SocialTransactionError()
      const state = generateToken()
      await transaction(deps.db, async (trx) => {
        const token = await trx
          .from('email_verification_tokens')
          .where('hash', hashToken(input.verificationToken))
          .where('expires_at', '>', now(trx))
          .where('purpose', 'activation')
          .first()
        if (!token) throw new SocialTransactionError()
        await lockUser(trx, deps.config, token.tokenable_id)
        const user = await deps.config.users.findById(token.tokenable_id, trx)
        if (!user || user.unverifiedEmail !== user.email || user.email !== token.email)
          throw new SocialTransactionError()
        const pending = await trx
          .from('social_identities')
          .where('user_id', user.id)
          .where('provider', input.provider)
          .whereNull('confirmed_at')
          .first()
        if (!pending) throw new SocialTransactionError()
        await trx.table('social_transactions').insert({
          hash: hashToken(state),
          provider: input.provider,
          intent: 'confirm',
          user_id: user.id,
          client_challenge: input.clientChallenge,
          verification_hash: hashToken(input.verificationToken),
          expires_at: expiry(trx),
          created_at: now(trx),
        })
      })
      return { state, url: await adapter.authorizationUrl(state, input.context) }
    },

    /** Consumes the state once, resolves the provider profile and returns the outcome. */
    async callback(input: SocialCallbackInput): Promise<SocialCallbackResult> {
      return socialCallback(deps, input)
    },

    /**
     * Exchanges a one-use handoff code and its verifier for a real session or token through
     * `guard`.
     */
    async redeemHandoff<Credential>(input: {
      code: string
      verifier: string
      guard: AuthenticationGuard<Credential>
    }): Promise<{ account: CurrentAccount; credential: Credential; provider: SocialProviderName }> {
      return redeemSocialHandoff(deps, input)
    },

    /** Finishes a `new` sign-in with the collected email or registration fields. */
    async completeRegistration(input: {
      continuation: string
      email?: string
      registrationData?: unknown
      admit?: (
        profile: { provider: SocialProviderName; subject: string; email: string },
        trx: Trx
      ) => Promise<void>
    }): Promise<SocialCallbackResult> {
      let unverified: UserId | undefined
      let settled: Awaited<ReturnType<typeof settleCommitted<SocialCallbackResult>>>
      try {
        settled = await settleCommitted(
          transaction(deps.db, async (trx): Promise<SocialCallbackResult> => {
            const state = await consumeState(trx, input.continuation)
            if (state.intent !== 'registration' || !state.provider_user_id)
              throw new SocialTransactionError()
            if (!enabledProviders(deps.config).includes(state.provider))
              throw new SocialTransactionError()
            const email = state.email ?? input.email
            if (!email || !isEmailShaped(email)) throw new SocialEmailMissingError()
            const profile = checkedProfile({
              subject: state.provider_user_id,
              email,
              emailVerified: state.email !== null && Boolean(state.email_verified),
              name: state.name,
              nickname: state.nickname,
              avatarUrl: state.avatar_url,
            })
            if (await deps.config.users.findByEmail(profile.email!, trx))
              return { status: 'link_required' }
            const created = await createAccount(
              deps,
              trx,
              state.provider,
              profile,
              input.registrationData,
              input.admit
            )
            if (!profile.emailVerified) {
              unverified = created.user.id
              return { status: 'new' as const, emailVerificationRequired: true as const }
            }
            return {
              status: 'new' as const,
              userId: created.user.id,
              handoffCode: await createHandoff(
                trx,
                deps.config,
                created.user.id,
                created.relation.id,
                state.client_challenge
              ),
            }
          })
        )
      } catch (error) {
        if (isIdentityConflict(error)) throw new SocialIdentityAlreadyLinkedError()
        if (await isUserEmailUniqueViolation(error, deps.config, deps.db))
          return { status: 'link_required' }
        throw error
      }
      await finishCommitted(
        settled.fault,
        'Social registration committed but follow-up failed',
        async () => {
          if (unverified && deps.config.enabled.includes('emailVerification')) {
            await sendVerification(deps, { userId: unverified })
          }
        }
      )
      return settled.value
    },

    /** Checks the password and issues a 10-minute, single-use proof for one sensitive purpose. */
    async provePassword(input: {
      current: CurrentAccountInput
      password: string
      purpose: SensitivePurpose
    }): Promise<string> {
      return proveSocialPassword(deps, input)
    },

    /** The caller's confirmed linked providers. */
    async list(input: { current: CurrentAccountInput }): Promise<SocialIdentity[]> {
      return listSocialIdentities(deps, input)
    },

    /** One of the caller's confirmed linked providers. */
    async get(input: {
      current: CurrentAccountInput
      identityId: number
    }): Promise<SocialIdentity> {
      const relations = await this.list({ current: input.current })
      const found = relations.find((item) => item.id === input.identityId)
      if (!found) throw new SocialUserNotFoundError()
      return found
    },

    /**
     * Unlinks a provider with a `social_unlink` proof, keeping at least one way to sign in. A
     * credential change: older sessions and tokens end.
     */
    async unlink(input: {
      current: CurrentAccountInput
      identityId: number
      proof: string
    }): Promise<void> {
      return unlinkSocialIdentity(deps, input)
    },
  }
}
