import { DateTime } from 'luxon'
import { issueProof } from '../../src/social_proofs.js'
import { transaction } from '../../src/transaction.js'
import type { ResolvedConfig, SensitivePurpose, UserId } from '../../src/types.js'
import type { TestApp } from './app.js'
import { unwrapId } from './users_adapter.js'

const iso = (value: DateTime) => value.toUTC().toISO()
export const soon = () => iso(DateTime.utc().plus({ hours: 1 }))
export const past = () => iso(DateTime.utc().minus({ hours: 1 }))

/**
 * One row in every package table that can hold a user's data, each with a distinct secret, so
 * tests can prove an export leaks none of them and a deletion leaves none behind.
 */
export async function seedAccountRows(kit: TestApp, userId: UserId, tag: string) {
  const secrets = {
    identityMeta: `meta-${tag}-${'m'.repeat(16)}`,
    transaction: `tx-${tag}-${'t'.repeat(54)}`,
    proof: `proof-${tag}-${'p'.repeat(51)}`,
    handoff: `handoff-${tag}-${'h'.repeat(49)}`,
    reset: `reset-${tag}-${'r'.repeat(51)}`,
    verification: `verify-${tag}-${'v'.repeat(50)}`,
    invitation: `invite-${tag}-${'i'.repeat(50)}`,
    accessToken: `token-${tag}-${'a'.repeat(51)}`,
  }
  const now = iso(DateTime.utc())
  const [identity] = await kit.db
    .table('social_identities')
    .insert({
      user_id: userId,
      provider: 'github',
      provider_user_id: `subject-${tag}`,
      email: `${tag}@github.test`,
      email_verified: true,
      name: `Name ${tag}`,
      nickname: `nick-${tag}`,
      avatar_url: `https://avatars.test/${tag}.png`,
      meta: JSON.stringify({ secret: secrets.identityMeta }),
      confirmed_at: '2026-01-02T03:04:05.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: now,
    })
    .returning('id')
  await kit.db.table('social_transactions').insert({
    hash: secrets.transaction,
    provider: 'github',
    intent: 'link',
    client_challenge: 'c'.repeat(43),
    user_id: userId,
    expires_at: soon(),
    created_at: now,
  })
  await kit.db.table('social_sensitive_proofs').insert({
    hash: secrets.proof,
    user_id: userId,
    purpose: 'social_link',
    expires_at: soon(),
    created_at: now,
  })
  await kit.db.table('social_handoff_codes').insert({
    hash: secrets.handoff,
    user_id: userId,
    social_identity_id: unwrapId(identity),
    client_challenge: 'c'.repeat(43),
    expires_at: soon(),
    created_at: now,
  })
  await kit.db.table('password_reset_tokens').insert({
    tokenable_id: userId,
    email: `${tag}@example.test`,
    hash: secrets.reset,
    expires_at: soon(),
    created_at: now,
  })
  await kit.db.table('email_verification_tokens').insert({
    tokenable_id: userId,
    email: `${tag}-new@example.test`,
    current_email: `${tag}@example.test`,
    purpose: 'email_change',
    hash: secrets.verification,
    expires_at: soon(),
    created_at: now,
  })
  await kit.db.table('account_invitations').insert({
    email: `invitee-${tag}@example.test`,
    role: 'member',
    inviter_id: userId,
    token_hash: secrets.invitation,
    expires_at: '2026-12-01T00:00:00.000Z',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: now,
  })
  await kit.db.table('auth_access_tokens').insert({
    tokenable_id: userId,
    name: `Laptop ${tag}`,
    hash: secrets.accessToken,
    created_at: '2026-10-01T00:00:00.000Z',
    last_used_at: null,
    expires_at: null,
  })
  return secrets
}

/** Package tables keyed by the user, with the column that holds the user id. */
export const userTables = [
  ['social_handoff_codes', 'user_id'],
  ['social_sensitive_proofs', 'user_id'],
  ['social_transactions', 'user_id'],
  ['social_identities', 'user_id'],
  ['password_reset_tokens', 'tokenable_id'],
  ['email_verification_tokens', 'tokenable_id'],
  ['account_invitations', 'inviter_id'],
  ['auth_access_tokens', 'tokenable_id'],
] as const

/** Row counts per table for one user, through the given query client. */
export async function userRowCounts(
  client: { from(table: string): any },
  userId: UserId
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const [table, column] of userTables) {
    const rows = await client.from(table).where(column, userId)
    counts[table] = rows.length
  }
  return counts
}

/** Issue a recent social proof the way a fresh provider re-authentication would. */
export function issueRecentProof(
  kit: TestApp,
  config: ResolvedConfig,
  userId: UserId,
  purpose: SensitivePurpose
): Promise<string> {
  return transaction(kit.db, (trx) => issueProof(trx, config, userId, purpose))
}
