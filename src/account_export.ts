// The account export: one versioned JSON document of the data Account Kit holds for a user.
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { DateTime } from 'luxon'
import { confirmActor } from './actor_confirmation.js'
import { revision } from './authentication.js'
import { transaction } from './db.js'
import { settleCommitted } from './effects.js'
import type { PostCommitError } from './errors.js'
import { throttlerOf, type Throttler } from './throttle.js'
import type { AccountDataInput, AccountExport, ResolvedConfig, Trx, UserId } from './types.js'
import { sqlTimestamp } from './timestamps.js'

type Stored = Date | string | null | undefined

const faults = new WeakMap<AccountExport, PostCommitError>()

/** The fault raised after an export committed, if any. The document is still complete. */
export function exportFault(document: AccountExport): PostCommitError | undefined {
  return faults.get(document)
}

function timestamp(value: Stored): string | null {
  if (value === null || value === undefined) return null
  const parsed =
    value instanceof Date
      ? DateTime.fromJSDate(value, { zone: 'utc' })
      : DateTime.fromISO(value, { zone: 'utc' }).isValid
        ? DateTime.fromISO(value, { zone: 'utc' })
        : DateTime.fromSQL(value, { zone: 'utc' })
  if (!parsed.isValid) throw new Error('account_kit: unreadable stored timestamp')
  return parsed.toUTC().toISO()
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
    .from('password_reset_tokens')
    .where('tokenable_id', userId)
    .where('expires_at', '>', now)
    .first()
  const verification = await trx
    .from('email_verification_tokens')
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
    createdAt: timestamp(row.created_at),
    lastUsedAt: timestamp(row.last_used_at),
    expiresAt: timestamp(row.expires_at),
  }))
}

export async function exportAccountData(
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService; throttler?: Throttler },
  input: AccountDataInput
): Promise<AccountExport> {
  const { config } = deps
  await throttlerOf(deps).consume('identity:user', String(input.actorId), config.throttle)
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
      const identities = await trx.from('social_identities').where('user_id', user.id).orderBy('id')
      const invitations = await trx
        .from('account_invitations')
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
          credentialsChangedAt: await revision(trx, config, user.id),
        },
        socialIdentities: identities.map((row) => ({
          provider: row.provider,
          providerUserId: row.provider_user_id,
          email: row.email,
          emailVerified: Boolean(row.email_verified),
          name: row.name,
          nickname: row.nickname,
          avatarUrl: row.avatar_url,
          confirmedAt: timestamp(row.confirmed_at),
          createdAt: timestamp(row.created_at)!,
        })),
        invitationsSent: invitations.map((row) => ({
          email: row.email,
          role: row.role,
          createdAt: timestamp(row.created_at)!,
          expiresAt: timestamp(row.expires_at)!,
        })),
        ...(config.authentication?.strategy === 'access_tokens'
          ? { accessTokens: await accessTokens(trx, config, user.id) }
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
