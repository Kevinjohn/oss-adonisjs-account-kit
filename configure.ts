import { access, readdir } from 'node:fs/promises'
import type Configure from '@adonisjs/core/commands/configure'

export const migrationNames = [
  'create_password_reset_tokens',
  'create_account_invitations',
  'create_account_email_changes',
  'add_email_verified_at_to_users',
  'create_account_transaction_lock',
]

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export type UserIdType = 'integer' | 'string' | 'uuid'

/** Metadata for newly generated migrations; existing application files are never rewritten. */
export function migrationSchema(usersTable = 'users', userIdType: UserIdType = 'integer') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(usersTable))
    throw new Error('account_kit: users-table must be a plain SQL identifier')
  if (!['integer', 'string', 'uuid'].includes(userIdType))
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
    inviterIdColumn: column('inviter_id'),
  }
}

export async function configure(command: Configure) {
  const schema = migrationSchema(
    command.parsedFlags['users-table'] ?? command.parsedFlags.usersTable ?? 'users',
    command.parsedFlags['user-id-type'] ?? command.parsedFlags.userIdType ?? 'integer'
  )
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

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('adonisjs-account-kit/providers/account_kit_provider')
    rcFile.addCommand('adonisjs-account-kit/commands')
  })

  // The generated config builds links from APP_URL. Declare it in start/env.ts so a missing
  // value fails at boot; defineEnvValidations leaves an existing declaration unchanged.
  try {
    await access(command.app.makePath('start/env.ts'))
  } catch (error) {
    if (!isMissing(error)) throw error
    command.logger.warning('start/env.ts not found; declare APP_URL as a validated URL manually')
    return
  }
  await codemods.defineEnvValidations({
    leadingComment: 'Variables for adonisjs-account-kit',
    variables: { APP_URL: "Env.schema.string({ format: 'url', tld: false })" },
  })
}
