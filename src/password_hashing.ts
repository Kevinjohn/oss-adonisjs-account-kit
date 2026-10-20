// Hashing a new password before its write transaction, for adapters that store a ready hash.
import type { Trx, UserId, UsersAdapter } from './types.js'

/** A new password to write: already hashed when the adapter offers `hashPassword`. */
export type PreparedPassword = { plain: string } | { hash: string }

/**
 * Hash `plain` now, outside any transaction, when the adapter offers `hashPassword`, so the slow
 * hash never holds a write transaction open. Otherwise the adapter hashes inside it, as before.
 */
export async function preparePassword(
  users: UsersAdapter,
  plain: string
): Promise<PreparedPassword> {
  return users.hashPassword ? { hash: await users.hashPassword(plain) } : { plain }
}

/** The password attributes `users.create` receives for a prepared password. */
export function passwordAttributes(prepared: PreparedPassword): {
  password: string | null
  passwordHash?: string
} {
  return 'hash' in prepared
    ? { password: null, passwordHash: prepared.hash }
    : { password: prepared.plain }
}

/** Store a prepared password through `trx`. */
export async function storePassword(
  users: UsersAdapter,
  id: UserId,
  prepared: PreparedPassword,
  trx: Trx
): Promise<void> {
  if ('plain' in prepared) return users.setPassword(id, prepared.plain, trx)
  await users.setPasswordHash!(id, prepared.hash, trx)
}
