// Which user-keyed package tables the account export reads, and which it leaves out and why.
import { packageTables } from './package_tables.js'

/**
 * The `table.column` entries `exportAccountData` reads. The configured access-token table is not
 * listed: the application owns it, so the package migrations do not create it.
 */
export const exportedUserColumns = [
  `${packageTables.socialIdentities}.user_id`,
  `${packageTables.accountInvitations}.inviter_id`,
  `${packageTables.passwordResetTokens}.tokenable_id`,
  `${packageTables.emailVerificationTokens}.tokenable_id`,
  `${packageTables.accountSessions}.user_id`,
] as const

/** The `table.column` entries the export deliberately leaves out, each with its reason. */
export const omittedUserColumns = [
  {
    column: `${packageTables.socialTransactions}.user_id`,
    reason: 'In-flight social sign-in state that expires within minutes.',
  },
  {
    column: `${packageTables.socialSensitiveProofs}.user_id`,
    reason: 'In-flight social sign-in state that expires within minutes.',
  },
  {
    column: `${packageTables.socialHandoffCodes}.user_id`,
    reason: 'In-flight social sign-in state that expires within minutes.',
  },
  {
    column: `${packageTables.loginLinkTokens}.tokenable_id`,
    reason: 'Magic sign-in links are single-use, short-lived secrets (15 minutes by default).',
  },
] as const
