import { RuntimeException } from '@adonisjs/core/exceptions'
import { isSqlIdentifier } from '../sql_identifier.ts'

export const migrationNames = [
  'add_account_columns_to_users',
  'create_password_reset_tokens',
  'create_email_verification_tokens',
  'create_account_invitations',
  'create_account_transaction_lock',
  'create_social_identities',
  'create_social_transactions',
  'create_social_sensitive_proofs',
  'create_social_handoff_codes',
  'create_login_link_tokens',
  'create_account_sessions',
  'add_scope_to_account_invitations',
]

/** The file-name ending that identifies an Account Kit migration, after its timestamp. */
export function formatMigrationSuffix(name: string): string {
  return `_account_kit_${name}.ts`
}

/**
 * Reports whether a migration file, as `.ts`, `.js`, `.cjs` or `.mjs`, is the Account Kit migration
 * with this name, whatever its timestamp or subdirectory.
 */
export function matchesAccountKitMigration(file: string, name: string): boolean {
  return file.replace(/\.(?:[cm]?js|ts)$/, '.ts').endsWith(formatMigrationSuffix(name))
}

const userIdTypes = ['integer', 'string', 'uuid'] as const
export type UserIdType = (typeof userIdTypes)[number]

/** Metadata for newly generated migrations; existing application files are never rewritten. */
export function buildMigrationSchema(usersTable = 'users', userIdType: UserIdType = 'integer') {
  if (!isSqlIdentifier(usersTable))
    throw new RuntimeException('account_kit: users-table must be a plain SQL identifier')
  if (!userIdTypes.includes(userIdType))
    throw new RuntimeException('account_kit: user-id-type must be integer, string or uuid')
  const formatColumnDeclaration = (name: string) =>
    userIdType === 'integer'
      ? `table.integer('${name}').unsigned()`
      : userIdType === 'uuid'
        ? `table.uuid('${name}')`
        : `table.string('${name}', 254)`
  return {
    usersTable: JSON.stringify(usersTable),
    userIdColumn: formatColumnDeclaration('user_id'),
    tokenableIdColumn: formatColumnDeclaration('tokenable_id'),
    inviterIdColumn: formatColumnDeclaration('inviter_id'),
    actorIdColumn: formatColumnDeclaration('approval_actor_id'),
  }
}
