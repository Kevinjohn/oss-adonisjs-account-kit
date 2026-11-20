import { sqlTimestamp } from './timestamps.js'
import type { Database } from '@adonisjs/lucid/database'
import { deletedCount } from './consume_rows.js'
import { packageTables, type PackageTable } from './package_tables.js'

/**
 * Options for `maintenance.prune`: rows per batch, the most batches to run, and `dryRun` to count
 * without deleting.
 */
export interface PruneInput {
  /** Rows deleted per batch. Default 100. */
  batchSize?: number
  /** The most batches in one run, shared across all eight tables. Default 100.
   * Use at least eight on sustained-load schedules so each nonempty table receives a turn.
   * Each invocation starts at the first table again. */
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

const TABLES: Array<[keyof PruneCounts, PackageTable]> = [
  ['recovery', packageTables.passwordResetTokens],
  ['invitations', packageTables.accountInvitations],
  ['emailVerifications', packageTables.emailVerificationTokens],
  ['socialTransactions', packageTables.socialTransactions],
  ['socialSensitiveProofs', packageTables.socialSensitiveProofs],
  ['socialHandoffCodes', packageTables.socialHandoffCodes],
  ['loginLinks', packageTables.loginLinkTokens],
  ['sessions', packageTables.accountSessions],
]

/** Remove expired rows in small batches, rechecking expiry when each selected batch is deleted. */
export async function pruneExpired(db: Database, input: PruneInput = {}): Promise<PruneCounts> {
  const { counts } = await pruneExpiredWithScanStatus(db, input)
  return counts
}

/** Track whether each table was fully scanned within the shared batch budget. */
export async function pruneExpiredWithScanStatus(db: Database, input: PruneInput) {
  const batchSize = input.batchSize ?? 100
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new RangeError('batchSize must be an integer from 1 to 1000')
  const maxBatches = input.maxBatches ?? 100
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 1000)
    throw new RangeError('maxBatches must be an integer from 1 to 1000')
  const cutoff = sqlTimestamp(db)
  const counts = Object.fromEntries(TABLES.map(([key]) => [key, 0])) as unknown as PruneCounts
  const cursorsByTable = new Map<PackageTable, number>()
  const done = new Set<PackageTable>()
  for (let batch = 0; batch < maxBatches && done.size < TABLES.length;) {
    for (const [key, table] of TABLES) {
      if (done.has(table) || batch >= maxBatches) continue
      const selected = await db
        .from(table)
        .select('id')
        .where('id', '>', cursorsByTable.get(table) ?? 0)
        .where('expires_at', '<=', cutoff)
        .orderBy('id', 'asc')
        .limit(batchSize)
      if (selected.length === 0) {
        done.add(table)
        continue
      }
      batch++
      const ids = selected.map((row) => row.id as number)
      cursorsByTable.set(table, ids[ids.length - 1])
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
  const scans = TABLES.map(([key, table]) => ({
    key,
    status: done.has(table) ? 'complete' : cursorsByTable.has(table) ? 'partial' : 'unvisited',
  }))
  return { counts, scans }
}
