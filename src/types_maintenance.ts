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
