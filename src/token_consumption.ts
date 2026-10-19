// One-use token consumption: deleting a live token row, under the user's lock when user-bound.
import { sqlTimestamp } from './timestamps.js'
import { InvalidTokenError } from './errors.js'
import { hashToken } from './tokens.js'
import { consumeRows } from './consume_rows.js'
import { lockUser, type UsersStorage } from './user_lock.js'
import type { AccountUser, Trx, UserId } from './types.js'

type TokenTable =
  | 'password_reset_tokens'
  | 'email_verification_tokens'
  | 'account_invitations'
  | 'login_link_tokens'

/** User-bound proof tables with `tokenable_id` and `hash` columns. */
export type UserTokenTable =
  'password_reset_tokens' | 'email_verification_tokens' | 'login_link_tokens'

/** Delete one unexpired token row and return it, or null when no live row matched. */
export async function consumeToken<Row>(
  trx: Trx,
  table: TokenTable,
  tokenHash: string,
  now: string
): Promise<Row | null> {
  const hashColumn = table === 'account_invitations' ? 'token_hash' : 'hash'
  const rows = await consumeRows<Row>(trx, table, { [hashColumn]: tokenHash }, now)
  return rows[0] ?? null
}

/**
 * Consume a user-bound token under the user's lock. Every credential operation locks the user
 * before touching a token table, so the unlocked lookup only chooses the lock target; the
 * consuming delete then revalidates the live token.
 */
export async function consumeUserToken<Row extends { tokenable_id: UserId }>(
  trx: Trx,
  config: UsersStorage,
  table: UserTokenTable,
  token: string,
  validForUser: (row: Row, user: AccountUser) => boolean
): Promise<{ row: Row; user: AccountUser }> {
  return consumeUserTokenHash(trx, config, table, hashToken(token), validForUser)
}

/** Consume a hash already bound to a one-use server-side social transaction. */
export async function consumeUserTokenHash<Row extends { tokenable_id: UserId }>(
  trx: Trx,
  config: UsersStorage,
  table: UserTokenTable,
  tokenHash: string,
  validForUser: (row: Row, user: AccountUser) => boolean
): Promise<{ row: Row; user: AccountUser }> {
  const candidate = await trx.from(table).select('tokenable_id').where('hash', tokenHash).first()
  if (!candidate) throw new InvalidTokenError()
  await lockUser(trx, config, candidate.tokenable_id)
  const user = await config.users.findById(candidate.tokenable_id, trx)
  const row = await consumeToken<Row>(trx, table, tokenHash, sqlTimestamp(trx))
  if (!row || row.tokenable_id !== candidate.tokenable_id || !user || !validForUser(row, user))
    throw new InvalidTokenError()
  return { row, user }
}
