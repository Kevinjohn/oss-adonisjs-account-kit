import { createHash, randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import {
  credentialsChanged,
  currentInTransaction,
  revision,
  safeAccount,
} from './authentication.js'
import { deleteReturning, lockUser, transaction, isUserEmailUniqueViolation } from './db.js'
import { finishCommitted, postCommit, settleCommitted, type PostCommitEffect } from './effects.js'
import { isEmailShaped, normaliseEmail } from './email.js'
import { mapRegistrationFields } from './registration_fields.js'
import {
  InvalidInputError,
  LastLoginMethodError,
  SocialEmailMissingError,
  SocialIdentityAlreadyLinkedError,
  SocialProofError,
  SocialTransactionError,
  SocialUserNotFoundError,
} from './errors.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import type {
  AccountUser,
  AuthenticationGuard,
  CurrentAccount,
  CurrentAccountInput,
  ResolvedConfig,
  SensitivePurpose,
  SocialBeginInput,
  SocialCallbackInput,
  SocialCallbackResult,
  SocialIdentity,
  SocialIntent,
  SocialProviderName,
  VerifiedSocialAuthentication,
  Trx,
  UserId,
} from './types.js'

type Dependencies = { config: ResolvedConfig; db: Database; limiter: LimiterService }
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
const MINUTES = 10
const FRESH_CLOCK_TOLERANCE_MS = 30_000
const expiry = () => DateTime.utc().plus({ minutes: MINUTES }).toISO()
const now = () => DateTime.utc().toISO()
const challengeFrom = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url')
const validChallenge = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

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

async function createHandoff(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId,
  socialIdentityId: number,
  clientChallenge: string
): Promise<string> {
  const code = generateToken(32)
  await trx.table('social_handoff_codes').insert({
    hash: hashToken(code),
    user_id: userId,
    social_identity_id: socialIdentityId,
    credential_revision: await revision(trx, config, userId),
    client_challenge: clientChallenge,
    expires_at: DateTime.utc().plus({ minutes: 2 }).toISO(),
    created_at: now(),
  })
  return code
}

function provider(deps: Dependencies, name: SocialProviderName) {
  const selected = deps.config.socialAuthentication?.providers[name]
  if (!selected || (name !== 'google' && name !== 'github'))
    throw new InvalidInputError('Unsupported social provider')
  return selected
}

function checkedProfile(value: ProviderProfile): ProviderProfile {
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
    email: value.email === null ? null : normaliseEmail(value.email),
    emailVerified: value.emailVerified === true,
    name: value.name?.slice(0, 255) ?? null,
    nickname: value.nickname?.slice(0, 255) ?? null,
    avatarUrl: value.avatarUrl?.slice(0, 2048) ?? null,
  }
}

function identity(row: Record<string, unknown>): SocialIdentity {
  return {
    id: Number(row.id),
    userId: row.user_id as UserId,
    provider: row.provider as SocialProviderName,
    providerUserId: row.provider_user_id as string,
    email: row.email as string | null,
    emailVerified: row.email_verified === true || row.email_verified === 1,
  }
}

function confirmedRecipient(user: AccountUser): boolean {
  return user.emailVerifiedAt !== null && user.unverifiedEmail !== user.email
}

function enabledProviders(config: ResolvedConfig): SocialProviderName[] {
  return (['google', 'github'] as const).filter(
    (name) => config.socialAuthentication?.providers[name] !== undefined
  )
}

async function usableHandoffAssociation(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId,
  socialIdentityId: number
): Promise<SocialProviderName | null> {
  const row = await trx
    .from('social_identities')
    .where('id', socialIdentityId)
    .where('user_id', userId)
    .whereNotNull('confirmed_at')
    .first()
  return row && enabledProviders(config).includes(row.provider)
    ? (row.provider as SocialProviderName)
    : null
}

async function consumeState(trx: Trx, state: string): Promise<SocialTransactionRow> {
  if (!isTokenShaped(state)) throw new SocialTransactionError()
  const rows = await deleteReturning<SocialTransactionRow>(
    trx,
    'delete from social_transactions where hash = ? and expires_at > ? returning *',
    [hashToken(state), now()]
  )
  if (rows.length !== 1) throw new SocialTransactionError()
  return rows[0]
}

export async function consumeSocialSensitiveProof(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId,
  purpose: SensitivePurpose,
  proof: string
): Promise<void> {
  if (!isTokenShaped(proof)) throw new SocialProofError()
  return consumeSocialSensitiveProofHash(trx, config, userId, purpose, hashToken(proof))
}

async function consumeSocialSensitiveProofHash(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId,
  purpose: SensitivePurpose,
  proofHash: string
): Promise<void> {
  await lockUser(trx, config, userId)
  const rows = await deleteReturning<{ credential_revision: string | null }>(
    trx,
    'delete from social_sensitive_proofs where hash = ? and user_id = ? and purpose = ? and expires_at > ? returning credential_revision',
    [proofHash, userId, purpose, now()]
  )
  if (rows.length !== 1 || rows[0].credential_revision !== (await revision(trx, config, userId)))
    throw new SocialProofError()
}

async function issueProof(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId,
  purpose: SensitivePurpose
): Promise<string> {
  const proof = generateToken()
  await trx.table('social_sensitive_proofs').insert({
    hash: hashToken(proof),
    user_id: userId,
    purpose,
    credential_revision: await revision(trx, config, userId),
    expires_at: expiry(),
    created_at: now(),
  })
  return proof
}

async function authenticated(
  deps: Dependencies,
  current: CurrentAccountInput | undefined,
  trx: Trx
): Promise<AccountUser> {
  if (!current) throw new SocialProofError()
  await currentInTransaction(deps, current, trx)
  const user = await deps.config.users.findById(current.userId, trx)
  if (!user) throw new SocialUserNotFoundError()
  return user
}

async function createAssociation(
  trx: Trx,
  userId: UserId,
  name: SocialProviderName,
  profile: ProviderProfile,
  confirmed: boolean
): Promise<SocialIdentity> {
  const timestamp = now()
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

function isIdentityConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const detail = error as { code?: string; constraint?: string; message?: string }
  return (
    (detail.code === '23505' &&
      detail.constraint?.startsWith('social_identities_provider_provider_user_id_unique') ===
        true) ||
    (detail.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
      detail.message?.includes('social_identities.provider, social_identities.provider_user_id') ===
        true)
  )
}

async function createAccount(
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

export function socialIdentityService(deps: Dependencies) {
  return {
    async begin(input: SocialBeginInput): Promise<{ state: string; url: string }> {
      const adapter = provider(deps, input.provider)
      if (!validChallenge(input.clientChallenge)) throw new SocialTransactionError()
      if (input.intent !== 'login' && input.intent !== 'link' && input.intent !== 'reauth')
        throw new SocialTransactionError()
      if (input.proof !== undefined && (input.intent !== 'link' || !isTokenShaped(input.proof)))
        throw new SocialProofError()
      if (
        input.intent === 'reauth' &&
        !['social_link', 'social_unlink', 'password_change', 'email_change'].includes(
          input.purpose ?? ''
        )
      )
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
          expires_at: expiry(),
          created_at: now(),
        })
      })
      return { state, url: await adapter.authorizationUrl(state, input.context) }
    },

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
          .where('expires_at', '>', now())
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
          expires_at: expiry(),
          created_at: now(),
        })
      })
      return { state, url: await adapter.authorizationUrl(state, input.context) }
    },

    async callback(input: SocialCallbackInput): Promise<SocialCallbackResult> {
      if (!isTokenShaped(input.state)) throw new SocialTransactionError()
      const candidate = await deps.db
        .from('social_transactions')
        .where('hash', hashToken(input.state))
        .where('expires_at', '>', now())
        .first()
      if (!candidate || candidate.intent === 'registration') throw new SocialTransactionError()
      const name = candidate.provider as SocialProviderName
      if (input.provider !== undefined && input.provider !== name)
        throw new SocialTransactionError()
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
                  expires_at: expiry(),
                  created_at: now(),
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
              const { completeActivationByHash } = await import('./verification.js')
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
            await consumeSocialSensitiveProofHash(
              trx,
              deps.config,
              user.id,
              'social_link',
              proofHash
            )
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
            const { sendVerification } = await import('./verification.js')
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
    },

    async redeemHandoff<Credential>(input: {
      code: string
      verifier: string
      guard: AuthenticationGuard<Credential>
    }): Promise<{ account: CurrentAccount; credential: Credential; provider: SocialProviderName }> {
      const auth = deps.config.authentication!
      if (
        !isTokenShaped(input.code) ||
        typeof input.verifier !== 'string' ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier) ||
        input.guard.strategy !== auth.strategy ||
        input.guard.name !== auth.guard
      )
        throw new SocialTransactionError()
      const verified = await transaction(deps.db, async (trx) => {
        const candidate = await trx
          .from('social_handoff_codes')
          .where('hash', hashToken(input.code))
          .first()
        if (!candidate) throw new SocialTransactionError()
        await lockUser(trx, deps.config, candidate.user_id)
        const rows = await deleteReturning<typeof candidate>(
          trx,
          'delete from social_handoff_codes where hash = ? and expires_at > ? returning *',
          [hashToken(input.code), now()]
        )
        const row = rows[0]
        if (
          !row ||
          row.user_id !== candidate.user_id ||
          row.client_challenge !== challengeFrom(input.verifier)
        )
          throw new SocialTransactionError()
        const user = await deps.config.users.findById(row.user_id, trx)
        if (!user || !(await auth.canAccess(user, trx))) throw new SocialTransactionError()
        const currentRevision = await revision(trx, deps.config, user.id)
        const establishedProvider = await usableHandoffAssociation(
          trx,
          deps.config,
          user.id,
          row.social_identity_id
        )
        if (currentRevision !== row.credential_revision || !establishedProvider)
          throw new SocialTransactionError()
        return {
          account: safeAccount(user),
          revision: currentRevision,
          socialIdentityId: row.social_identity_id as number,
          provider: establishedProvider,
        }
      })
      let credential: Credential | undefined
      try {
        credential =
          input.guard.strategy === 'session'
            ? await input.guard.establish(verified.account.id, verified.revision)
            : await input.guard.establish(
                verified.account.id,
                auth.tokenAbilities,
                auth.tokenExpiresIn
              )
        await transaction(deps.db, async (trx) => {
          await lockUser(trx, deps.config, verified.account.id)
          const user = await deps.config.users.findById(verified.account.id, trx)
          if (
            !user ||
            (await revision(trx, deps.config, user.id)) !== verified.revision ||
            (await usableHandoffAssociation(
              trx,
              deps.config,
              user.id,
              verified.socialIdentityId
            )) !== verified.provider ||
            !(await auth.canAccess(user, trx))
          )
            throw new SocialTransactionError()
        })
        return { account: verified.account, credential, provider: verified.provider }
      } catch (error) {
        try {
          await input.guard.terminate(credential)
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Social credential cleanup failed')
        }
        throw error
      }
    },

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
            const { sendVerification } = await import('./verification.js')
            await sendVerification(deps, { userId: unverified })
          }
        }
      )
      return settled.value
    },

    async provePassword(input: {
      current: CurrentAccountInput
      password: string
      purpose: SensitivePurpose
    }): Promise<string> {
      if (
        typeof input.password !== 'string' ||
        !['social_link', 'social_unlink', 'password_change', 'email_change'].includes(input.purpose)
      )
        throw new SocialProofError()
      return transaction(deps.db, async (trx) => {
        const user = await authenticated(deps, input.current, trx)
        if (
          !user.hasPassword ||
          !(await deps.config.users.verifyPassword(user.id, input.password, trx))
        )
          throw new SocialProofError()
        return issueProof(trx, deps.config, user.id, input.purpose)
      })
    },

    async list(input: { current: CurrentAccountInput }): Promise<SocialIdentity[]> {
      return transaction(deps.db, async (trx) => {
        const user = await authenticated(deps, input.current, trx)
        const rows = await trx
          .from('social_identities')
          .where('user_id', user.id)
          .whereNotNull('confirmed_at')
          .orderBy('id', 'asc')
        return rows.map(identity)
      })
    },

    async get(input: {
      current: CurrentAccountInput
      identityId: number
    }): Promise<SocialIdentity> {
      const relations = await this.list({ current: input.current })
      const found = relations.find((item) => item.id === input.identityId)
      if (!found) throw new SocialUserNotFoundError()
      return found
    },

    async unlink(input: {
      current: CurrentAccountInput
      identityId: number
      proof: string
    }): Promise<void> {
      let notice: { user: AccountUser; relation: SocialIdentity } | undefined
      let changed: AccountUser | undefined
      const operationId = randomUUID()
      const { fault } = await settleCommitted(
        transaction(deps.db, async (trx) => {
          const user = await authenticated(deps, input.current, trx)
          const row = await trx
            .from('social_identities')
            .where('id', input.identityId)
            .where('user_id', user.id)
            .first()
          if (!row) throw new SocialUserNotFoundError()
          await consumeSocialSensitiveProof(trx, deps.config, user.id, 'social_unlink', input.proof)
          const remaining = await trx
            .from('social_identities')
            .where('user_id', user.id)
            .whereNot('id', input.identityId)
            .whereNotNull('confirmed_at')
            .whereIn('provider', enabledProviders(deps.config))
            .count('* as total')
            .first()
          if (!user.hasPassword && Number(remaining?.total ?? 0) === 0)
            throw new LastLoginMethodError()
          await trx
            .from('social_identities')
            .where('id', input.identityId)
            .where('user_id', user.id)
            .delete()
          // Removing a login method is a credential change: advance the revision so sessions
          // and tokens established through the provider end, clear pending callbacks (including
          // one already resolving provider assurance, so a later relink cannot revive it) and
          // sensitive proofs, and run the application's transactional hook.
          changed = (await deps.config.users.findById(user.id, trx)) ?? user
          await credentialsChanged(trx, deps.config, changed, {
            operation: 'social_unlink',
            operationId,
            userId: user.id,
          })
          if (row.confirmed_at) notice = { user, relation: identity(row) }
        })
      )
      await finishCommitted(fault, 'Social unlink committed but follow-up failed', async () => {
        const effects: PostCommitEffect[] = []
        if (changed) {
          const user = changed
          effects.push({
            kind: 'observer',
            run: async () => {
              await deps.config.onCredentialsChanged?.(user, {
                operation: 'social_unlink',
                operationId,
                userId: user.id,
              })
            },
          })
        }
        if (notice && confirmedRecipient(notice.user)) {
          const { user, relation } = notice
          effects.push({
            kind: 'delivery',
            run: () => deps.config.notify.socialIdentityUnlinked(user, relation),
          })
        }
        if (effects.length)
          await postCommit('Social identity unlinked but a follow-up failed', effects)
      })
    },
  }
}
