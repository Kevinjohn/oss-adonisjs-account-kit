// The names of the tables the package migrations create.
import { sessionTable } from './session_registry.js'

export const packageTables = {
  passwordResetTokens: 'password_reset_tokens',
  emailVerificationTokens: 'email_verification_tokens',
  accountInvitations: 'account_invitations',
  socialIdentities: 'social_identities',
  socialTransactions: 'social_transactions',
  socialSensitiveProofs: 'social_sensitive_proofs',
  socialHandoffCodes: 'social_handoff_codes',
  loginLinkTokens: 'login_link_tokens',
  accountSessions: sessionTable,
  accountTransactionLock: 'account_transaction_lock',
} as const

export type PackageTable = (typeof packageTables)[keyof typeof packageTables]
