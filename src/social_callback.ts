import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { requireAccountAccessDecision } from './account_access_decision.ts'
import { revision } from './credential_revision.ts'
import { lockUser, transaction, isUserEmailUniqueViolation, isUniqueViolation } from './db.ts'
import { consumeRows } from './consume_rows.ts'
import { finishCommitted, postCommit, settleCommitted } from './effects.ts'
import { emitInvitationAccepted } from './invitation_match.ts'
import { createHandoff } from './social_handoff.ts'
import { hasConfirmedAddress, isActiveAccount } from './account_projection.ts'
import { consumeSocialSensitiveProofHash, issueProof } from './social_proofs.ts'
import {
  E_ACCOUNT_KIT_INVALID_INPUT,
  E_ACCOUNT_KIT_SOCIAL_IDENTITY_ALREADY_LINKED,
  E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID,
  E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID,
  E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND,
  E_ACCOUNT_KIT_UNVERIFIED_EMAIL,
} from './errors.ts'
import { readTimestamp } from './timestamps.ts'
import { generateToken, hashToken, isTokenShaped } from './tokens.ts'
import { isSocialProviderName } from './social_providers.ts'
import {
  requireAuthenticatedUser,
  calculateSocialExpiry,
  readSqlTimestamp,
  type Dependencies,
  type SocialTransactionResult,
} from './social_shared.ts'
import { completeActivationByHash } from './verification.ts'
import { sendSocialActivation } from './social_activation.ts'
import type {
  SensitivePurpose,
  SocialCallbackInput,
  SocialCallbackResult,
  SocialIntent,
  SocialProviderName,
  VerifiedSocialAuthentication,
  Trx,
  UserId,
} from './types.ts'

import {
  requireProviderProfile,
  createAccount,
  createAssociation,
  type ProviderProfile,
} from './social_account_creation.ts'
export { requireProviderProfile, createAccount } from './social_account_creation.ts'

interface SocialTransactionRow {
  hash: string
  provider: SocialProviderName
  intent: SocialIntent | 'registration'
  purpose: SensitivePurpose | null
  user_id: UserId | null
  provider_user_id: string | null
  email: string | null
  email_verified: boolean | number | null
  name: string | null
  nickname: string | null
  avatar_url: string | null
  client_challenge: string
  verification_hash: string | null
  proof_hash: string | null
  credential_revision: string | null
  created_at: string | Date
}
const FRESH_CLOCK_TOLERANCE_MS = 30_000

/** Allow small provider clock skew before state creation, but never a future authentication. */
function freshAuthenticationMatches(
  evidence: VerifiedSocialAuthentication | null,
  subject: string,
  startedAt: string | Date
): boolean {
  if (
    !evidence ||
    evidence.verified !== true ||
    evidence.subject !== subject ||
    typeof evidence.authenticatedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(evidence.authenticatedAt)
  )
    return false
  const verifiedAt = DateTime.fromISO(evidence.authenticatedAt, { zone: 'utc' })
  const started = readTimestamp(startedAt)!
  const current = DateTime.utc()
  return (
    verifiedAt.isValid &&
    started.isValid &&
    verifiedAt.toMillis() >= started.toMillis() - FRESH_CLOCK_TOLERANCE_MS &&
    verifiedAt.toMillis() <= current.toMillis()
  )
}

export function requireSocialProvider(deps: Dependencies, name: SocialProviderName) {
  const selected = deps.config.socialAuthentication?.providers[name]
  if (!selected || !isSocialProviderName(name))
    throw new E_ACCOUNT_KIT_INVALID_INPUT('Unsupported social provider')
  return selected
}

export async function consumeState(trx: Trx, state: string): Promise<SocialTransactionRow> {
  if (!isTokenShaped(state)) throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
  const rows = await consumeRows<SocialTransactionRow>(
    trx,
    'social_transactions',
    { hash: hashToken(state) },
    readSqlTimestamp(trx)
  )
  if (rows.length !== 1) throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
  return rows[0]
}

export function isIdentityConflict(error: unknown): boolean {
  return isUniqueViolation(error, 'social_identities', ['provider', 'provider_user_id'])
}

/**
 * Consumes the state once, resolves the provider profile and returns the outcome.
 *
 * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
 */
export async function completeSocialCallback(
  deps: Dependencies,
  input: SocialCallbackInput
): Promise<SocialCallbackResult> {
  if (!isTokenShaped(input.state)) throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
  const candidate = await deps.db
    .from('social_transactions')
    .where('hash', hashToken(input.state))
    .where('expires_at', '>', readSqlTimestamp(deps.db))
    .first()
  if (!candidate || candidate.intent === 'registration')
    throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
  const name = candidate.provider as SocialProviderName
  if (input.provider !== undefined && input.provider !== name)
    throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
  let profile: ProviderProfile
  let freshEvidence: VerifiedSocialAuthentication | null = null
  try {
    const adapter = requireSocialProvider(deps, name)
    profile = requireProviderProfile(await adapter.resolve(input.callback))
    if (candidate.intent === 'reauth') {
      if (!adapter.verifyFreshAuthentication) throw new E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID()
      freshEvidence = await adapter.verifyFreshAuthentication(input.callback, {
        state: input.state,
        subject: profile.subject,
      })
    }
  } catch (cause) {
    throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID({ cause })
  }
  let userCreateFailure: unknown
  let settled: Awaited<ReturnType<typeof settleCommitted<SocialTransactionResult>>>
  try {
    settled = await settleCommitted(
      transaction(deps.db, async (trx): Promise<SocialTransactionResult> => {
        userCreateFailure = undefined
        if (candidate.user_id) await lockUser(trx, deps.config, candidate.user_id)
        else if (candidate.intent === 'login') {
          const association = await trx
            .from('social_identities')
            .where('provider', name)
            .where('provider_user_id', profile.subject)
            .first()
          if (association) await lockUser(trx, deps.config, association.user_id)
        }
        const state = await consumeState(trx, input.state)
        if (
          state.provider !== name ||
          state.intent !== candidate.intent ||
          (input.intent && input.intent !== state.intent)
        )
          throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
        if (state.intent === 'login') {
          const stored = await trx
            .from('social_identities')
            .where('provider', name)
            .where('provider_user_id', profile.subject)
            .first()
          if (stored) {
            if (!stored.confirmed_at) {
              // The account this identity created was never activated: send activation again
              // instead of refusing this provider subject for good.
              const owner = await deps.config.users.findById(stored.user_id, trx)
              if (owner && !isActiveAccount(owner)) {
                return {
                  result: { status: 'new', emailVerificationRequired: true },
                  unverified: owner.id,
                }
              }
              throw new E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND()
            }
            const user = await deps.config.users.findById(stored.user_id, trx)
            if (!user) throw new E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND()
            const auth = deps.config.authentication!
            if (!requireAccountAccessDecision(await auth.canAccess(user, trx)))
              throw new E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND()
            return {
              result: {
                status: 'linked',
                userId: user.id,
                handoffCode: await createHandoff(
                  trx,
                  deps.config,
                  user.id,
                  stored.id,
                  state.client_challenge
                ),
              },
            }
          }
          if (profile.email && (await deps.config.users.findByEmail(profile.email, trx)))
            return { result: { status: 'link_required' } }
          if (deps.config.registration!.availability === 'closed')
            throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
          if (
            !profile.email ||
            deps.config.registration!.mapFields ||
            deps.config.registration!.availability === 'application'
          ) {
            const continuation = generateToken()
            await trx.table('social_transactions').insert({
              hash: hashToken(continuation),
              provider: name,
              intent: 'registration',
              client_challenge: state.client_challenge,
              user_id: null,
              provider_user_id: profile.subject,
              email: profile.email,
              email_verified: profile.emailVerified,
              name: profile.name ?? null,
              nickname: profile.nickname ?? null,
              avatar_url: profile.avatarUrl ?? null,
              expires_at: calculateSocialExpiry(trx),
              created_at: readSqlTimestamp(trx),
            })
            return {
              result: {
                status: 'new',
                continuation,
              },
            }
          }
          const created = await createAccount(
            deps,
            trx,
            name,
            profile,
            undefined,
            input.admit,
            (error) => {
              userCreateFailure = error
            }
          )
          const accepted =
            created.invitationIds.length > 0
              ? { invitationIds: created.invitationIds, userId: created.user.id }
              : undefined
          if (!profile.emailVerified) {
            return {
              result: { status: 'new', emailVerificationRequired: true },
              unverified: created.user.id,
              accepted,
            }
          }
          return {
            accepted,
            result: {
              status: 'new',
              userId: created.user.id,
              handoffCode: await createHandoff(
                trx,
                deps.config,
                created.user.id,
                created.relation.id,
                state.client_challenge
              ),
            },
          }
        }
        if (state.intent === 'confirm') {
          if (
            !state.verification_hash ||
            (input.verificationToken !== undefined &&
              hashToken(input.verificationToken) !== state.verification_hash) ||
            !state.user_id
          )
            throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
          const pending = await trx
            .from('social_identities')
            .where('user_id', state.user_id)
            .where('provider', name)
            .where('provider_user_id', profile.subject)
            .whereNull('confirmed_at')
            .first()
          if (!pending) throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
          const { userId, invitationIds } = await completeActivationByHash(
            trx,
            deps.config,
            state.verification_hash!,
            pending.id
          )
          const accepted = invitationIds.length > 0 ? { invitationIds, userId } : undefined
          return {
            accepted,
            result: {
              status: 'linked',
              userId,
              handoffCode: await createHandoff(
                trx,
                deps.config,
                userId,
                pending.id,
                state.client_challenge
              ),
            },
          }
        }
        if (state.user_id === null || input.current?.userId !== state.user_id)
          throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
        const user = await requireAuthenticatedUser(deps, input.current, trx)
        if (state.intent === 'reauth') {
          if (
            !freshAuthenticationMatches(freshEvidence, profile.subject, state.created_at) ||
            state.credential_revision !== (await revision(trx, deps.config, user.id))
          )
            throw new E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID()
          const stored = await trx
            .from('social_identities')
            .where('user_id', user.id)
            .where('provider', name)
            .where('provider_user_id', profile.subject)
            .first()
          if (!stored || !stored.confirmed_at || user.hasPassword)
            throw new E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID()
          if (!state.purpose) throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
          return {
            result: {
              status: 'reauthenticated',
              proof: await issueProof(trx, deps.config, user.id, state.purpose),
            },
          }
        }
        const proofHash = state.proof_hash ?? (input.proof ? hashToken(input.proof) : null)
        if (!proofHash) throw new E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID()
        await consumeSocialSensitiveProofHash(trx, deps.config, user.id, 'social_link', proofHash)
        // A confirmed link survives the email-owner claim, so an unconfirmed account cannot link.
        if (!isActiveAccount(user)) throw new E_ACCOUNT_KIT_UNVERIFIED_EMAIL()
        const existing = await trx
          .from('social_identities')
          .where('provider', name)
          .where('provider_user_id', profile.subject)
          .first()
        if (existing) throw new E_ACCOUNT_KIT_SOCIAL_IDENTITY_ALREADY_LINKED()
        await deps.config.socialAuthentication!.acceptLink?.(user, {
          provider: name,
          subject: profile.subject,
          email: profile.email,
          emailVerified: profile.emailVerified,
        })
        const relation = await createAssociation(trx, user.id, name, profile, true)
        return { result: { status: 'linked', userId: user.id }, linkedNotice: { user, relation } }
      })
    )
  } catch (error) {
    if (isIdentityConflict(error)) throw new E_ACCOUNT_KIT_SOCIAL_IDENTITY_ALREADY_LINKED()
    if (await isUserEmailUniqueViolation(error, deps.config, deps.db)) {
      if (error === userCreateFailure) return { status: 'link_required' }
      throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
    }
    throw error
  }
  const { result, unverified, accepted, linkedNotice } = settled.value
  await finishCommitted(
    settled.fault,
    'Social callback committed but follow-up failed',
    async () => {
      if (accepted)
        await postCommit(
          'Invitation follow-up failed',
          emitInvitationAccepted(deps.config, accepted.invitationIds, accepted.userId, randomUUID())
        )
      if (unverified && deps.config.enabled.includes('emailVerification')) {
        await sendSocialActivation(deps, unverified)
      }
      if (linkedNotice && hasConfirmedAddress(linkedNotice.user)) {
        const { user, relation } = linkedNotice
        await postCommit('Social identity linked but notice failed', [
          {
            kind: 'delivery',
            run: () => deps.config.notify.socialIdentityLinked(user, relation),
          },
        ])
      }
    }
  )
  return result
}
