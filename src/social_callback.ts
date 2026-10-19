// The provider callback: consumes the state once, resolves the profile and settles the outcome.
import { DateTime } from 'luxon'
import { revision } from './authentication.js'
import { lockUser, transaction, isUserEmailUniqueViolation, mysqlDuplicateKey } from './db.js'
import { consumeRows } from './consume_rows.js'
import { finishCommitted, postCommit, settleCommitted } from './effects.js'
import { isEmailShaped, normalizeEmail } from './email.js'
import { mapRegistrationFields } from './registration_fields.js'
import { createHandoff } from './social_handoff.js'
import { confirmedRecipient, identity } from './social_links.js'
import { consumeSocialSensitiveProofHash, issueProof } from './social_proofs.js'
import {
  InvalidInputError,
  SocialEmailMissingError,
  SocialIdentityAlreadyLinkedError,
  SocialProofError,
  SocialTransactionError,
  SocialUserNotFoundError,
} from './errors.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import { isSocialProviderName } from './social_providers.js'
import { authenticated, expiry, now, type Dependencies } from './social_shared.js'
import { completeActivationByHash, sendVerification } from './verification.js'
import type {
  AccountUser,
  SensitivePurpose,
  SocialCallbackInput,
  SocialCallbackResult,
  SocialIdentity,
  SocialIntent,
  SocialProviderName,
  VerifiedSocialAuthentication,
  Trx,
  UserId,
} from './types.js'

interface ProviderProfile {
  subject: string
  email: string | null
  emailVerified: boolean
  name?: string | null
  nickname?: string | null
  avatarUrl?: string | null
}
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
  const started = DateTime.fromJSDate(new Date(startedAt), { zone: 'utc' })
  const current = DateTime.utc()
  return (
    verifiedAt.isValid &&
    started.isValid &&
    verifiedAt.toMillis() >= started.toMillis() - FRESH_CLOCK_TOLERANCE_MS &&
    verifiedAt.toMillis() <= current.toMillis()
  )
}

export function provider(deps: Dependencies, name: SocialProviderName) {
  const selected = deps.config.socialAuthentication?.providers[name]
  if (!selected || !isSocialProviderName(name))
    throw new InvalidInputError('Unsupported social provider')
  return selected
}

export function checkedProfile(value: ProviderProfile): ProviderProfile {
  if (
    !value ||
    typeof value.subject !== 'string' ||
    value.subject.length === 0 ||
    value.subject.length > 255
  )
    throw new SocialTransactionError()
  if (value.email !== null && !isEmailShaped(value.email)) throw new SocialTransactionError()
  for (const key of ['name', 'nickname', 'avatarUrl'] as const) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string')
      throw new SocialTransactionError()
  }
  return {
    subject: value.subject,
    email: value.email === null ? null : normalizeEmail(value.email),
    emailVerified: value.emailVerified === true,
    name: value.name?.slice(0, 255) ?? null,
    nickname: value.nickname?.slice(0, 255) ?? null,
    avatarUrl: value.avatarUrl?.slice(0, 2048) ?? null,
  }
}

export async function consumeState(trx: Trx, state: string): Promise<SocialTransactionRow> {
  if (!isTokenShaped(state)) throw new SocialTransactionError()
  const rows = await consumeRows<SocialTransactionRow>(
    trx,
    'social_transactions',
    { hash: hashToken(state) },
    now(trx)
  )
  if (rows.length !== 1) throw new SocialTransactionError()
  return rows[0]
}

async function createAssociation(
  trx: Trx,
  userId: UserId,
  name: SocialProviderName,
  profile: ProviderProfile,
  confirmed: boolean
): Promise<SocialIdentity> {
  const timestamp = now(trx)
  await trx.table('social_identities').insert({
    user_id: userId,
    provider: name,
    provider_user_id: profile.subject,
    email: profile.email,
    email_verified: profile.emailVerified,
    name: profile.name ?? null,
    nickname: profile.nickname ?? null,
    avatar_url: profile.avatarUrl ?? null,
    confirmed_at: confirmed ? timestamp : null,
    created_at: timestamp,
    updated_at: timestamp,
  })
  const created = await trx
    .from('social_identities')
    .where('provider', name)
    .where('provider_user_id', profile.subject)
    .first()
  if (!created) throw new SocialTransactionError()
  return identity(created)
}

export function isIdentityConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const detail = error as { code?: string; constraint?: string; message?: string }
  const mysqlKey = mysqlDuplicateKey(error)
  if (mysqlKey !== undefined)
    return mysqlKey === 'social_identities.social_identities_provider_provider_user_id_unique'
  return (
    (detail.code === '23505' &&
      detail.constraint?.startsWith('social_identities_provider_provider_user_id_unique') ===
        true) ||
    (detail.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
      detail.message?.includes('social_identities.provider, social_identities.provider_user_id') ===
        true)
  )
}

export async function createAccount(
  deps: Dependencies,
  trx: Trx,
  name: SocialProviderName,
  profile: ProviderProfile,
  registrationData?: unknown,
  admit?: (
    profile: { provider: SocialProviderName; subject: string; email: string },
    trx: Trx
  ) => Promise<void>
): Promise<{ user: AccountUser; relation: SocialIdentity }> {
  const registration = deps.config.registration!
  if (registration.availability === 'closed') throw new SocialTransactionError()
  if (registration.availability === 'application' && !admit) throw new SocialTransactionError()
  if (!profile.email) throw new SocialEmailMissingError()
  if (admit) await admit({ provider: name, subject: profile.subject, email: profile.email }, trx)
  if (await deps.config.users.findByEmail(profile.email, trx)) throw new SocialTransactionError()
  const mapped = await mapRegistrationFields(deps.config, registrationData)
  const user = await deps.config.users.create(
    {
      email: profile.email,
      unverifiedEmail: profile.emailVerified ? null : profile.email,
      password: null,
      registrationData: mapped,
    },
    trx
  )
  if (profile.emailVerified) await deps.config.users.markEmailVerified(user.id, DateTime.utc(), trx)
  const relation = await createAssociation(trx, user.id, name, profile, profile.emailVerified)
  const latest = await deps.config.users.findById(user.id, trx)
  if (!latest) throw new SocialTransactionError()
  return { user: latest, relation }
}

/** Consumes the state once, resolves the provider profile and returns the outcome. */
export async function socialCallback(
  deps: Dependencies,
  input: SocialCallbackInput
): Promise<SocialCallbackResult> {
  if (!isTokenShaped(input.state)) throw new SocialTransactionError()
  const candidate = await deps.db
    .from('social_transactions')
    .where('hash', hashToken(input.state))
    .where('expires_at', '>', now(deps.db))
    .first()
  if (!candidate || candidate.intent === 'registration') throw new SocialTransactionError()
  const name = candidate.provider as SocialProviderName
  if (input.provider !== undefined && input.provider !== name) throw new SocialTransactionError()
  let profile: ProviderProfile
  let freshEvidence: VerifiedSocialAuthentication | null = null
  try {
    const adapter = provider(deps, name)
    profile = checkedProfile(await adapter.resolve(input.callback))
    if (candidate.intent === 'reauth') {
      if (!adapter.verifyFreshAuthentication) throw new SocialProofError()
      freshEvidence = await adapter.verifyFreshAuthentication(input.callback, {
        state: input.state,
        subject: profile.subject,
      })
    }
  } catch (cause) {
    throw new SocialTransactionError({ cause })
  }
  let linkedNotice: { user: AccountUser; relation: SocialIdentity } | undefined
  let unverified: UserId | undefined
  let settled: Awaited<ReturnType<typeof settleCommitted<SocialCallbackResult>>>
  try {
    settled = await settleCommitted(
      transaction(deps.db, async (trx): Promise<SocialCallbackResult> => {
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
          throw new SocialTransactionError()
        if (state.intent === 'login') {
          const stored = await trx
            .from('social_identities')
            .where('provider', name)
            .where('provider_user_id', profile.subject)
            .first()
          if (stored) {
            if (!stored.confirmed_at) throw new SocialUserNotFoundError()
            const user = await deps.config.users.findById(stored.user_id, trx)
            if (!user) throw new SocialUserNotFoundError()
            const auth = deps.config.authentication!
            if (!(await auth.canAccess(user, trx))) throw new SocialUserNotFoundError()
            return {
              status: 'linked',
              userId: user.id,
              handoffCode: await createHandoff(
                trx,
                deps.config,
                user.id,
                stored.id,
                state.client_challenge
              ),
            }
          }
          if (profile.email && (await deps.config.users.findByEmail(profile.email, trx)))
            return { status: 'link_required' }
          if (deps.config.registration!.availability === 'closed')
            throw new SocialTransactionError()
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
              expires_at: expiry(trx),
              created_at: now(trx),
            })
            return {
              status: 'new',
              continuation,
            }
          }
          const created = await createAccount(deps, trx, name, profile)
          if (!profile.emailVerified) {
            unverified = created.user.id
            return { status: 'new', emailVerificationRequired: true }
          }
          return {
            status: 'new',
            userId: created.user.id,
            handoffCode: await createHandoff(
              trx,
              deps.config,
              created.user.id,
              created.relation.id,
              state.client_challenge
            ),
          }
        }
        if (state.intent === 'confirm') {
          if (
            !state.verification_hash ||
            (input.verificationToken !== undefined &&
              hashToken(input.verificationToken) !== state.verification_hash) ||
            !state.user_id
          )
            throw new SocialTransactionError()
          const pending = await trx
            .from('social_identities')
            .where('user_id', state.user_id)
            .where('provider', name)
            .where('provider_user_id', profile.subject)
            .whereNull('confirmed_at')
            .first()
          if (!pending) throw new SocialTransactionError()
          const userId = await completeActivationByHash(
            trx,
            deps.config,
            state.verification_hash!,
            pending.id
          )
          return {
            status: 'linked',
            userId,
            handoffCode: await createHandoff(
              trx,
              deps.config,
              userId,
              pending.id,
              state.client_challenge
            ),
          }
        }
        if (state.user_id === null || input.current?.userId !== state.user_id)
          throw new SocialTransactionError()
        const user = await authenticated(deps, input.current, trx)
        if (state.intent === 'reauth') {
          if (
            !freshAuthenticationMatches(freshEvidence, profile.subject, state.created_at) ||
            state.credential_revision !== (await revision(trx, deps.config, user.id))
          )
            throw new SocialProofError()
          const stored = await trx
            .from('social_identities')
            .where('user_id', user.id)
            .where('provider', name)
            .where('provider_user_id', profile.subject)
            .first()
          if (!stored || !stored.confirmed_at || user.hasPassword) throw new SocialProofError()
          if (!state.purpose) throw new SocialTransactionError()
          return {
            status: 'reauthenticated',
            proof: await issueProof(trx, deps.config, user.id, state.purpose),
          }
        }
        const proofHash = state.proof_hash ?? (input.proof ? hashToken(input.proof) : null)
        if (!proofHash) throw new SocialProofError()
        await consumeSocialSensitiveProofHash(trx, deps.config, user.id, 'social_link', proofHash)
        const existing = await trx
          .from('social_identities')
          .where('provider', name)
          .where('provider_user_id', profile.subject)
          .first()
        if (existing) throw new SocialIdentityAlreadyLinkedError()
        const relation = await createAssociation(trx, user.id, name, profile, true)
        linkedNotice = { user, relation }
        return { status: 'linked', userId: user.id }
      })
    )
  } catch (error) {
    if (isIdentityConflict(error)) throw new SocialIdentityAlreadyLinkedError()
    if (await isUserEmailUniqueViolation(error, deps.config, deps.db))
      throw new SocialTransactionError()
    throw error
  }
  await finishCommitted(
    settled.fault,
    'Social callback committed but follow-up failed',
    async () => {
      if (unverified && deps.config.enabled.includes('emailVerification')) {
        await sendVerification(deps, { userId: unverified })
      }
      if (linkedNotice && confirmedRecipient(linkedNotice.user)) {
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
  return settled.value
}
