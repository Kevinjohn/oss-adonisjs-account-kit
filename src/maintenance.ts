import { sqlTimestamp } from './timestamps.js'
import type { Database } from '@adonisjs/lucid/database'
import { deletedCount } from './consume_rows.js'
import { sessionTable } from './session_registry.js'

type TokenTable =
  | 'password_reset_tokens'
  | 'account_invitations'
  | 'email_verification_tokens'
  | 'social_transactions'
  | 'social_sensitive_proofs'
  | 'social_handoff_codes'
  | 'login_link_tokens'
  | typeof sessionTable

/**
 * Options for `maintenance.prune`: rows per batch, the most batches to run, and `dryRun` to count
 * without deleting.
 */
export interface PruneInput {
  /** Rows deleted per batch. Default 100. */
  batchSize?: number
  /** The most batches in one run, shared across all tables. Default 100. */
  maxBatches?: number
  /** Count expired rows without deleting them. */
  dryRun?: boolean
}

/** How many expired rows `maintenance.prune` deleted, or would delete, per table. */
export interface PruneCounts {
  recovery: number
  invitations: number
  emailVerifications: number
  socialTransactions: number
  socialSensitiveProofs: number
  socialHandoffCodes: number
  loginLinks: number
  sessions: number
}

const TABLES: Array<[keyof PruneCounts, TokenTable]> = [
  ['recovery', 'password_reset_tokens'],
  ['invitations', 'account_invitations'],
  ['emailVerifications', 'email_verification_tokens'],
  ['socialTransactions', 'social_transactions'],
  ['socialSensitiveProofs', 'social_sensitive_proofs'],
  ['socialHandoffCodes', 'social_handoff_codes'],
  ['loginLinks', 'login_link_tokens'],
  ['sessions', sessionTable],
]

/** Remove expired rows in small batches, rechecking expiry when each selected batch is deleted. */
export async function pruneExpired(db: Database, input: PruneInput = {}): Promise<PruneCounts> {
  const batchSize = input.batchSize ?? 100
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new RangeError('batchSize must be an integer from 1 to 1000')
  const maxBatches = input.maxBatches ?? 100
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 1000)
    throw new RangeError('maxBatches must be an integer from 1 to 1000')
  const cutoff = sqlTimestamp(db)
  const counts = Object.fromEntries(TABLES.map(([key]) => [key, 0])) as unknown as PruneCounts
  const cursors = new Map<TokenTable, number>()
  const done = new Set<TokenTable>()
  for (let batch = 0; batch < maxBatches && done.size < TABLES.length;) {
    for (const [key, table] of TABLES) {
      if (done.has(table) || batch >= maxBatches) continue
      const selected = await db
        .from(table)
        .select('id')
        .where('id', '>', cursors.get(table) ?? 0)
        .where('expires_at', '<=', cutoff)
        .orderBy('id', 'asc')
        .limit(batchSize)
      if (selected.length === 0) {
        done.add(table)
        continue
      }
      batch++
      const ids = selected.map((row) => row.id as number)
      cursors.set(table, ids[ids.length - 1])
      if (input.dryRun) {
        const [{ total }] = await db
          .from(table)
          .whereIn('id', ids)
          .where('expires_at', '<=', cutoff)
          .count('* as total')
        counts[key] += Number(total)
      } else {
        counts[key] += deletedCount(
          await db.from(table).whereIn('id', ids).where('expires_at', '<=', cutoff).delete()
        )
      }
      if (selected.length < batchSize) done.add(table)
    }
  }
  return counts
}
