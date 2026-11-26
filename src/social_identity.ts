import { completeRegistration } from './social_registration.ts'
import { lockUser, transaction } from './db.ts'
import { isActiveAccount } from './account_projection.ts'
import { revision } from './credential_revision.ts'
import { redeemSocialHandoff } from './social_handoff.ts'
import { isClientChallenge } from './client_challenge.ts'
import { consumeSocialSensitiveProof, proveSocialPassword } from './social_proofs.ts'
import {
  E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID,
  E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID,
  E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND,
  E_ACCOUNT_KIT_UNVERIFIED_EMAIL,
} from './errors.ts'
import { generateToken, hashToken, isTokenShaped } from './tokens.ts'
import { requireSocialProvider, completeSocialCallback } from './social_callback.ts'
import { listSocialIdentities, unlinkSocialIdentity } from './social_links.ts'
import {
  requireAuthenticatedUser,
  calculateSocialExpiry,
  readSqlTimestamp,
  type Dependencies,
} from './social_shared.ts'
import { isSensitivePurpose, isSocialBeginIntent } from './social_enums.ts'
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
} from './types.ts'

export { consumeSocialSensitiveProof }

export function createSocialIdentityService(deps: Dependencies) {
  return {
    /**
     * Starts a provider flow and returns the one-use state and the provider URL to redirect to.
     *
     * @example
     * ```ts
     * await kit.socialAuthentication.begin({ provider: 'github', intent: 'login', clientChallenge })
     * ```
     */
    async begin(input: SocialBeginInput): Promise<{ state: string; url: string }> {
      const adapter = requireSocialProvider(deps, input.provider)
      if (!isClientChallenge(input.clientChallenge))
        throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
      if (!isSocialBeginIntent(input.intent)) throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
      if (input.proof !== undefined && (input.intent !== 'link' || !isTokenShaped(input.proof)))
        throw new E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID()
      if (input.intent === 'reauth' && !isSensitivePurpose(input.purpose))
        throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
      if (input.intent === 'reauth' && !adapter.verifyFreshAuthentication)
        throw new E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID()
      const state = generateToken()
      await transaction(deps.db, async (trx) => {
        const user =
          input.intent === 'login' ? null : await requireAuthenticatedUser(deps, input.current, trx)
        // A confirmed link outlives the email-owner claim, so only a confirmed owner may link.
        if (input.intent === 'link' && user && !isActiveAccount(user))
          throw new E_ACCOUNT_KIT_UNVERIFIED_EMAIL()
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
          expires_at: calculateSocialExpiry(trx),
          created_at: readSqlTimestamp(trx),
        })
      })
      return { state, url: await adapter.authorizationUrl(state, input.context) }
    },

    /**
     * Starts the fresh provider callback that confirms a pending identity, bound to its email
     * verification proof.
     *
     * @example
     * ```ts
     * await kit.socialAuthentication.beginConfirmation({ provider: 'github', verificationToken, clientChallenge })
     * ```
     */
    async beginConfirmation(input: {
      provider: SocialProviderName
      verificationToken: string
      clientChallenge: string
      context?: unknown
    }): Promise<{ state: string; url: string }> {
      const adapter = requireSocialProvider(deps, input.provider)
      if (!isClientChallenge(input.clientChallenge) || !isTokenShaped(input.verificationToken))
        throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
      const state = generateToken()
      await transaction(deps.db, async (trx) => {
        const token = await trx
          .from('email_verification_tokens')
          .where('hash', hashToken(input.verificationToken))
          .where('expires_at', '>', readSqlTimestamp(trx))
          .where('purpose', 'activation')
          .first()
        if (!token) throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
        await lockUser(trx, deps.config, token.tokenable_id)
        const user = await deps.config.users.findById(token.tokenable_id, trx)
        if (!user || isActiveAccount(user) || user.email !== token.email)
          throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
        const pending = await trx
          .from('social_identities')
          .where('user_id', user.id)
          .where('provider', input.provider)
          .whereNull('confirmed_at')
          .first()
        if (!pending) throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
        await trx.table('social_transactions').insert({
          hash: hashToken(state),
          provider: input.provider,
          intent: 'confirm',
          user_id: user.id,
          client_challenge: input.clientChallenge,
          verification_hash: hashToken(input.verificationToken),
          expires_at: calculateSocialExpiry(trx),
          created_at: readSqlTimestamp(trx),
        })
      })
      return { state, url: await adapter.authorizationUrl(state, input.context) }
    },

    /**
     * Consumes the state once, resolves the provider profile and returns the outcome.
     *
     * @example
     * ```ts
     * await kit.socialAuthentication.callback({ provider: 'github', state, callback: context })
     * ```
     */
    async callback(input: SocialCallbackInput): Promise<SocialCallbackResult> {
      return completeSocialCallback(deps, input)
    },

    /**
     * Exchanges a one-use handoff code and its verifier for a real session or token through
     * `guard`.
     *
     * @example
     * ```ts
     * await kit.socialAuthentication.redeemHandoff({ code, verifier, guard: requestGuard })
     * ```
     *
     * @throws {AggregateError} If work and its transaction or credential cleanup both fail, or multiple cleanup steps fail.
     */
    async redeemHandoff<Credential>(input: {
      code: string
      verifier: string
      guard: AuthenticationGuard<Credential>
    }): Promise<{ account: CurrentAccount; credential: Credential; provider: SocialProviderName }> {
      return redeemSocialHandoff(deps, input)
    },

    /**
     * Finishes a `new` sign-in with the collected email or registration fields.
     *
     * @example
     * ```ts
     * await kit.socialAuthentication.completeRegistration({ continuation, email: 'sam@example.test' })
     * ```
     */
    async completeRegistration(input: {
      continuation: string
      email?: string
      registrationData?: unknown
      admit?: (
        profile: { provider: SocialProviderName; subject: string; email: string },
        trx: Trx
      ) => Promise<void>
    }): Promise<SocialCallbackResult> {
      return completeRegistration(deps, input)
    },

    /**
     * Checks the password and issues a 10-minute, single-use proof for one sensitive purpose.
     *
     * @example
     * ```ts
     * await kit.socialAuthentication.provePassword({ current, password, purpose: 'social_unlink' })
     * ```
     */
    async provePassword(input: {
      current: CurrentAccountInput
      password: string
      purpose: SensitivePurpose
    }): Promise<string> {
      return proveSocialPassword(deps, input)
    },

    /**
     * The caller's confirmed linked providers.
     *
     * @example
     * ```ts
     * await kit.socialAuthentication.list({ current })
     * ```
     */
    async list(input: { current: CurrentAccountInput }): Promise<SocialIdentity[]> {
      return listSocialIdentities(deps, input)
    },

    /**
     * Returns a confirmed link owned by the caller, or throws `E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND`.
     *
     * @example
     * ```ts
     * await kit.socialAuthentication.get({ current, identityId })
     * ```
     */
    async get(input: {
      current: CurrentAccountInput
      identityId: number
    }): Promise<SocialIdentity> {
      const relations = await listSocialIdentities(deps, { current: input.current })
      const found = relations.find((item) => item.id === input.identityId)
      if (!found) throw new E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND()
      return found
    },

    /**
     * Unlinks a provider with a `social_unlink` proof, keeping at least one way to sign in. A
     * credential change: older sessions and tokens end.
     *
     * @example
     * ```ts
     * await kit.socialAuthentication.unlink({ current, identityId, proof })
     * ```
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
