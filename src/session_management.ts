// Lists and revokes the places a user is signed in, for session and access-token guards.
import { randomUUID } from 'node:crypto'
import {
  credentialsChanged,
  currentInTransaction,
  requireAuthentication,
} from './authentication.js'
import { deleteReturning } from './consume_rows.js'
import { transaction } from './db.js'
import { finishCommitted, lifecycle, postCommit, settleCommitted } from './effects.js'
import { CapabilityDisabledError, SessionNotFoundError } from './errors.js'
import { recordRevocation } from './session_revocation.js'
import { sessionTable } from './session_registry.js'
import { readIsoTimestamp } from './timestamps.js'
import { hashToken } from './tokens.js'
import type {
  CurrentAccountInput,
  ResolvedAuthenticationConfig,
  SignIn,
  Trx,
  UserId,
} from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'

function configured(
  deps: Pick<ServiceDependencies, 'config' | 'db'>
): ResolvedAuthenticationConfig {
  if (!deps.config.enabled.includes('sessionManagement'))
    throw new CapabilityDisabledError('Session management is disabled')
  return requireAuthentication(deps.config)
}

/** Row ids arrive from URLs; anything but a positive integer cannot name a sign-in. */
function signInId(value: unknown): number {
  const id = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
    throw new SessionNotFoundError()
  return id
}

/**
 * The table, owner column, label and last-seen column expressions, and id of the caller's own
 * sign-in.
 */
async function scope(trx: Trx, auth: ResolvedAuthenticationConfig, current: CurrentAccountInput) {
  if (auth.strategy === 'access_tokens')
    return {
      table: auth.tokenTable,
      owner: 'tokenable_id',
      label: 'name as label',
      lastSeen: 'last_used_at as last_seen_at',
      currentId: current.tokenId!,
    }
  const row = await trx
    .from(sessionTable)
    .select('id')
    .where('handle_hash', hashToken(current.sessionHandle!))
    .first()
  return {
    table: sessionTable,
    owner: 'user_id',
    label: 'label',
    lastSeen: 'last_seen_at',
    currentId: row.id as UserId,
  }
}

const sameId = (left: unknown, right: unknown) => String(left) === String(right)

/**
 * Delete the user's sign-in rows whose id is (`only`) or is not (`except`) `id`, and return the ids
 * actually deleted. PostgreSQL and SQLite use `delete ... returning`, so a row another statement
 * removed first is never reported. MySQL has no RETURNING; it locks the rows, then deletes them.
 */
async function deleteSignIns(
  trx: Trx,
  target: { table: string; owner: string },
  userId: UserId,
  match: 'only' | 'except',
  id: unknown
): Promise<number[]> {
  const operator = match === 'only' ? '=' : '<>'
  if (trx.dialect.name !== 'mysql') {
    const rows = await deleteReturning<{ id: unknown }>(
      trx,
      `delete from ?? where ?? = ? and id ${operator} ? returning id`,
      [target.table, target.owner, userId, id]
    )
    return rows.map((row) => Number(row.id))
  }
  const rows: Array<{ id: unknown }> = await trx
    .from(target.table)
    .select('id')
    .where(target.owner, userId)
    .where('id', operator, id as number)
    .forUpdate()
  const ids = rows.map((row) => Number(row.id))
  if (ids.length > 0) await trx.from(target.table).whereIn('id', ids).delete()
  return ids
}

export function sessionManagementService(deps: Pick<ServiceDependencies, 'config' | 'db'>) {
  /** Authenticate the caller and run `mutate` in one transaction under the account lock. */
  function asCurrent<T>(
    current: CurrentAccountInput,
    mutate: (trx: Trx, target: Awaited<ReturnType<typeof scope>>, userId: UserId) => Promise<T>
  ): Promise<T> {
    const auth = configured(deps)
    return transaction(deps.db, async (trx) => {
      const account = await currentInTransaction(deps, current, trx)
      return mutate(trx, await scope(trx, auth, current), account.id)
    })
  }

  async function announce(userId: UserId, count: number, operationId: string): Promise<void> {
    await postCommit('Sign-ins revoked but a follow-up failed', [
      lifecycle(deps.config, { type: 'sessions.revoked', userId, operationId, count }),
    ])
  }

  /** Run `onSessionsRevokedTransaction` for rows this call deleted. */
  async function revoked(trx: Trx, userId: UserId, operationId: string, signInIds: number[]) {
    if (!deps.config.onSessionsRevokedTransaction) return
    const user = (await deps.config.users.findById(userId, trx))!
    await deps.config.onSessionsRevokedTransaction(
      user,
      { userId, operationId, signInIds: Object.freeze(signInIds) },
      trx
    )
  }

  return {
    /** Every live sign-in of the caller, newest first, with the caller's own marked `current`. */
    list(input: { current: CurrentAccountInput }): Promise<SignIn[]> {
      return asCurrent(input.current, async (trx, target, userId) => {
        const rows = await trx
          .from(target.table)
          .select('id', target.label, 'created_at', target.lastSeen, 'expires_at')
          .where(target.owner, userId)
          .orderBy('id', 'desc')
        const now = Date.now()
        return rows
          .map((row) => ({
            id: Number(row.id),
            label: (row.label as string | null) ?? null,
            createdAt: readIsoTimestamp(row.created_at),
            lastSeenAt: readIsoTimestamp(row.last_seen_at),
            expiresAt: readIsoTimestamp(row.expires_at),
            current: sameId(row.id, target.currentId),
          }))
          .filter((row) => row.expiresAt === null || Date.parse(row.expiresAt) > now) as SignIn[]
      })
    },

    /** Sign out one sign-in. Unknown ids and other users' ids are indistinguishable. */
    async revoke(input: {
      current: CurrentAccountInput
      id: unknown
    }): Promise<{ current: boolean }> {
      const id = signInId(input.id)
      const operationId = randomUUID()
      const { value, fault } = await settleCommitted(
        asCurrent(input.current, async (trx, target, userId) => {
          const ids = await deleteSignIns(trx, target, userId, 'only', id)
          if (ids.length !== 1) throw new SessionNotFoundError()
          await revoked(trx, userId, operationId, ids)
          return { userId, current: sameId(id, target.currentId) }
        })
      )
      const result = { current: value.current }
      await recordRevocation(result, () =>
        finishCommitted(fault, 'Sign-in revoked but follow-ups failed', () =>
          announce(value.userId, 1, operationId)
        )
      )
      return result
    },

    /** Sign out every other sign-in; the caller's own stays valid. */
    async revokeOthers(input: { current: CurrentAccountInput }): Promise<{ count: number }> {
      const operationId = randomUUID()
      const { value, fault } = await settleCommitted(
        asCurrent(input.current, async (trx, target, userId) => {
          const ids = await deleteSignIns(trx, target, userId, 'except', target.currentId)
          if (ids.length > 0) await revoked(trx, userId, operationId, ids)
          return { userId, count: ids.length }
        })
      )
      await finishCommitted(fault, 'Sign-ins revoked but follow-ups failed', () =>
        announce(value.userId, value.count, operationId)
      )
      return { count: value.count }
    },

    /** Sign out everywhere, including here: a credential change with its usual hooks. */
    async revokeAll(input: { current: CurrentAccountInput }): Promise<void> {
      const operationId = randomUUID()
      const { value, fault } = await settleCommitted(
        asCurrent(input.current, async (trx, _target, userId) => {
          const user = (await deps.config.users.findById(userId, trx))!
          const context = { operation: 'sign_out_everywhere' as const, operationId, userId }
          await credentialsChanged(trx, deps.config, user, context)
          return { user, context }
        })
      )
      await finishCommitted(fault, 'Signed out everywhere but follow-ups failed', () =>
        postCommit('Signed out everywhere but a follow-up failed', [
          {
            kind: 'observer',
            run: () => deps.config.onCredentialsChanged?.(value.user, value.context),
          },
          lifecycle(deps.config, {
            type: 'sessions.revoked_all',
            userId: value.user.id,
            operationId,
          }),
        ])
      )
    },
  }
}
