import { readFile, readdir } from 'node:fs/promises'
import type Configure from '@adonisjs/core/commands/configure'
import { isSqlIdentifier } from './src/sql_identifier.js'

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
]

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

const userIdTypes = ['integer', 'string', 'uuid'] as const
export type UserIdType = (typeof userIdTypes)[number]

/** Metadata for newly generated migrations; existing application files are never rewritten. */
export function migrationSchema(usersTable = 'users', userIdType: UserIdType = 'integer') {
  if (!isSqlIdentifier(usersTable))
    throw new Error('account_kit: users-table must be a plain SQL identifier')
  if (!userIdTypes.includes(userIdType))
    throw new Error('account_kit: user-id-type must be integer, string or uuid')
  const column = (name: string) =>
    userIdType === 'integer'
      ? `table.integer('${name}').unsigned()`
      : userIdType === 'uuid'
        ? `table.uuid('${name}')`
        : `table.string('${name}', 254)`
  return {
    usersTable: JSON.stringify(usersTable),
    userIdColumn: column('user_id'),
    tokenableIdColumn: column('tokenable_id'),
    inviterIdColumn: column('inviter_id'),
  }
}

/**
 * Runs on `node ace add adonisjs-account-kit` or `node ace configure adonisjs-account-kit`: writes
 * `config/account_kit.ts`, generates the migrations and registers the provider and commands. Never
 * overwrites existing files. Flags: `--users-table` and `--user-id-type` (`integer`, `string` or
 * `uuid`).
 */
export async function configure(command: Configure) {
  let schema: ReturnType<typeof migrationSchema>
  try {
    schema = migrationSchema(
      command.parsedFlags['users-table'] ?? 'users',
      command.parsedFlags['user-id-type'] ?? 'integer'
    )
  } catch (error) {
    command.exitCode = 1
    command.logger.logError((error as Error).message)
    return
  }
  const codemods = await command.createCodemods()
  codemods.overwriteExisting = false
  await codemods.makeUsingStub(command.stubsRoot, 'config/account_kit.stub', {
    config: { destination: command.app.makePath('config/account_kit.ts') },
  })

  let migrationFiles: string[] = []
  try {
    migrationFiles = await readdir(command.app.makePath('database/migrations'))
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  const timestamp = Date.now()
  for (const [index, name] of migrationNames.entries()) {
    const suffix = `_account_kit_${name}.ts`
    if (migrationFiles.some((filename) => filename.endsWith(suffix))) {
      command.logger.info(`Skipped database/migrations/*${suffix}`)
      continue
    }
    await codemods.makeUsingStub(command.stubsRoot, `migrations/${name}.stub`, {
      migration: {
        ...schema,
        destination: command.app.makePath(`database/migrations/${timestamp + index}${suffix}`),
      },
    })
  }

  // Applications configured before the root export keep their registered legacy provider path.
  let rcContents = ''
  try {
    rcContents = await readFile(command.app.makePath('adonisrc.ts'), 'utf8')
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const hasLegacyProvider = /['"]adonisjs-account-kit\/providers\/account_kit_provider['"]/.test(
    rcContents
  )
  await codemods.updateRcFile((rcFile) => {
    if (!hasLegacyProvider) rcFile.addProvider('adonisjs-account-kit/account_kit_provider')
    rcFile.addCommand('adonisjs-account-kit/commands')
  })

  // The generated config builds links from APP_URL. Declare it in start/env.ts so a missing
  // value fails at boot; defineEnvValidations leaves an existing declaration unchanged.
  await codemods.defineEnvValidations({
    leadingComment: 'Variables for adonisjs-account-kit',
    variables: { APP_URL: "Env.schema.string({ format: 'url', tld: false })" },
  })
}
