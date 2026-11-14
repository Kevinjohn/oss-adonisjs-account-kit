// The account export: one versioned JSON document of the data Account Kit holds for a user.
import { DateTime } from 'luxon'
import { confirmActor } from './actor_confirmation.js'
import { revision } from './credential_revision.js'
import { transaction } from './db.js'
import { settleCommitted } from './effects.js'
import type { PostCommitError } from './errors.js'
import type { AccountDataInput, AccountExport, ResolvedConfig, Trx, UserId } from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'
import { readIsoTimestamp, sqlTimestamp } from './timestamps.js'
import { packageTables } from './package_tables.js'
import { sessionRegistryEnabled } from './session_registry.js'

const faults = new WeakMap<AccountExport, PostCommitError>()

/** The fault raised after an export committed, if any. The document is still complete. */
export function exportFault(document: AccountExport): PostCommitError | undefined {
  return faults.get(document)
}

/** Round-trip through JSON so the document holds exactly what a download would contain. */
function applicationSection(value: unknown): unknown {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch (cause) {
    throw new Error('account_kit: exportAccountData must return JSON-serialisable data', { cause })
  }
  if (text === undefined)
    throw new Error('account_kit: exportAccountData must return JSON-serialisable data')
  return JSON.parse(text)
}

async function pending(trx: Trx, userId: UserId): Promise<AccountExport['pending']> {
  const now = sqlTimestamp(trx)
  const reset = await trx
    .from(packageTables.passwordResetTokens)
    .where('tokenable_id', userId)
    .where('expires_at', '>', now)
    .first()
  const verification = await trx
    .from(packageTables.emailVerificationTokens)
    .select('purpose', 'email')
    .where('tokenable_id', userId)
    .where('expires_at', '>', now)
    .first()
  return {
    passwordReset: Boolean(reset),
    emailVerification: verification?.purpose === 'activation',
    emailChange: verification?.purpose === 'email_change' ? verification.email : null,
  }
}

async function accessTokens(trx: Trx, config: ResolvedConfig, userId: UserId) {
  const rows = await trx
    .from(config.authentication!.tokenTable)
    .select('id', 'name', 'created_at', 'last_used_at', 'expires_at')
    .where('tokenable_id', userId)
    .orderBy('id')
  return rows.map((row) => ({
    id: row.id,
    name: row.name ?? null,
    createdAt: readIsoTimestamp(row.created_at),
    lastUsedAt: readIsoTimestamp(row.last_used_at),
    expiresAt: readIsoTimestamp(row.expires_at),
  }))
}

async function signedInSessions(trx: Trx, userId: UserId) {
  const rows = await trx
    .from(packageTables.accountSessions)
    .select('id', 'label', 'created_at', 'last_seen_at', 'expires_at')
    .where('user_id', userId)
    .orderBy('id')
  return rows.map((row) => ({
    id: row.id,
    label: row.label ?? null,
    createdAt: readIsoTimestamp(row.created_at)!,
    lastSeenAt: readIsoTimestamp(row.last_seen_at)!,
    expiresAt: readIsoTimestamp(row.expires_at)!,
  }))
}

export async function exportAccountData(
  deps: ServiceDependencies,
  input: AccountDataInput
): Promise<AccountExport> {
  const { config } = deps
  await deps.throttler.consume('identity:user', String(input.actorId), config.throttle)
  const { value: document, fault } = await settleCommitted(
    transaction(deps.db, async (trx): Promise<AccountExport> => {
      const user = await confirmActor(
        config,
        trx,
        input.actorId,
        input.currentPassword,
        input.recentProof,
        'account_export'
      )
      const identities = await trx
        .from(packageTables.socialIdentities)
        .where('user_id', user.id)
        .orderBy('id')
      const invitations = await trx
        .from(packageTables.accountInvitations)
        .select('email', 'role', 'created_at', 'expires_at')
        .where('inviter_id', user.id)
        .orderBy('id')
      return {
        format: 'adonisjs-account-kit/export',
        version: 1,
        generatedAt: DateTime.utc().toISO(),
        account: {
          id: user.id,
          email: user.email,
          unverifiedEmail: user.unverifiedEmail,
          emailVerifiedAt: user.emailVerifiedAt?.toUTC().toISO() ?? null,
          hasPassword: user.hasPassword,
          // The column is required only when login is configured.
          credentialsChangedAt: config.authentication ? await revision(trx, config, user.id) : null,
        },
        socialIdentities: identities.map((row) => ({
          provider: row.provider,
          providerUserId: row.provider_user_id,
          email: row.email,
          emailVerified: Boolean(row.email_verified),
          name: row.name,
          nickname: row.nickname,
          avatarUrl: row.avatar_url,
          confirmedAt: readIsoTimestamp(row.confirmed_at),
          createdAt: readIsoTimestamp(row.created_at)!,
        })),
        invitationsSent: invitations.map((row) => ({
          email: row.email,
          role: row.role,
          createdAt: readIsoTimestamp(row.created_at)!,
          expiresAt: readIsoTimestamp(row.expires_at)!,
        })),
        ...(config.authentication?.strategy === 'access_tokens'
          ? { accessTokens: await accessTokens(trx, config, user.id) }
          : {}),
        ...(sessionRegistryEnabled(config)
          ? { sessions: await signedInSessions(trx, user.id) }
          : {}),
        pending: await pending(trx, user.id),
        application: config.exportAccountData
          ? applicationSection(await config.exportAccountData(user, trx))
          : null,
      }
    })
  )
  if (fault) faults.set(document, fault)
  return document
}
