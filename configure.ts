import { RuntimeException } from '@adonisjs/core/exceptions'
import { readdir } from 'node:fs/promises'
import type Configure from '@adonisjs/core/commands/configure'
import { isSqlIdentifier } from './src/sql_identifier.js'
import { stubsRoot } from './stubs/main.js'

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

const legacyProviderPath = 'adonisjs-account-kit/providers/account_kit_provider'

type RcNode = {
  getKindName(): string
  getText(): string
  getDescendants(): RcNode[]
  getArguments?(): RcNode[]
  getExpression?(): RcNode
  getProperty?(name: string): RcNode | undefined
  getInitializer?(): RcNode | undefined
  getElements?(): RcNode[]
  getBody?(): RcNode
  getStatements?(): RcNode[]
  getLiteralValue?(): string
}
type TsMorphProject = {
  getSourceFile(path: string): RcNode | undefined
  getProgram(): { getSyntacticDiagnostics(sourceFile: RcNode): unknown[] }
}

/**
 * Inspect the same defineConfig call and provider entry forms consumed by Assembler's RC
 * transformer. Returning false means the recognized config has no providers property yet.
 */
function hasLegacyProvider(project: TsMorphProject, rcPath: string): boolean {
  const rcFile = project.getSourceFile(rcPath)
  if (!rcFile) throw new Error('could not load adonisrc.ts from the Assembler TypeScript project')
  if (project.getProgram().getSyntacticDiagnostics(rcFile).length)
    throw new Error('adonisrc.ts contains TypeScript syntax errors')

  const call = rcFile.getDescendants().find((node) => {
    if (node.getKindName() !== 'CallExpression') return false
    return node.getExpression?.().getText() === 'defineConfig'
  })
  const config = call?.getArguments?.()[0]
  if (!config || config.getKindName() !== 'ObjectLiteralExpression')
    throw new Error('could not locate a supported defineConfig({ ... }) call in adonisrc.ts')

  const providersProperty = config.getProperty?.('providers')
  if (!providersProperty) return false
  if (providersProperty.getKindName() !== 'PropertyAssignment')
    throw new Error('the providers property is not a static array assignment')

  const providersArray = providersProperty.getInitializer?.()
  if (!providersArray || providersArray.getKindName() !== 'ArrayLiteralExpression')
    throw new Error('the providers property is not a static array')

  const importPathFromArrow = (node: RcNode) => {
    if (node.getKindName() !== 'ArrowFunction') return undefined
    const body = node.getBody?.()
    if (!body) return undefined
    let importCall: RcNode | undefined
    if (body.getKindName() === 'CallExpression') importCall = body
    else if (body.getKindName() === 'Block') {
      const statements = body.getStatements?.() ?? []
      if (statements.length !== 1 || statements[0].getKindName() !== 'ReturnStatement')
        return undefined
      importCall = statements[0].getExpression?.()
    }
    if (!importCall || importCall.getKindName() !== 'CallExpression') return undefined
    const [argument] = importCall.getArguments?.() ?? []
    if (
      importCall.getExpression?.().getKindName() !== 'ImportKeyword' ||
      !argument ||
      argument.getKindName() !== 'StringLiteral'
    )
      return undefined
    return argument.getLiteralValue?.()
  }

  let legacyFound = false
  for (const entry of providersArray.getElements?.() ?? []) {
    if (entry.getKindName() === 'ArrowFunction') {
      const path = importPathFromArrow(entry)
      if (!path) throw new Error('a providers entry is not a supported lazy import')
      if (path === legacyProviderPath) legacyFound = true
      continue
    }

    if (entry.getKindName() !== 'ObjectLiteralExpression')
      throw new Error('a providers entry is not a supported lazy import')
    const fileProperty = entry.getProperty?.('file')
    const initializer =
      fileProperty?.getKindName() === 'PropertyAssignment'
        ? fileProperty.getInitializer?.()
        : undefined
    const path = initializer && importPathFromArrow(initializer)
    if (!path) throw new Error('a providers object must have a static file lazy import')
    if (path === legacyProviderPath) legacyFound = true
  }
  return legacyFound
}

const userIdTypes = ['integer', 'string', 'uuid'] as const
export type UserIdType = (typeof userIdTypes)[number]

/** Metadata for newly generated migrations; existing application files are never rewritten. */
export function migrationSchema(usersTable = 'users', userIdType: UserIdType = 'integer') {
  if (!isSqlIdentifier(usersTable))
    throw new RuntimeException('account_kit: users-table must be a plain SQL identifier')
  if (!userIdTypes.includes(userIdType))
    throw new RuntimeException('account_kit: user-id-type must be integer, string or uuid')
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
    actorIdColumn: column('approval_actor_id'),
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

  let legacyProvider: boolean
  try {
    const project = await codemods.getTsMorphProject()
    if (!project) throw new Error('the Assembler TypeScript project is unavailable')
    legacyProvider = hasLegacyProvider(
      project as unknown as TsMorphProject,
      command.app.makePath('adonisrc.ts')
    )
  } catch (error) {
    command.exitCode = 1
    command.logger.logError(
      `Unable to inspect adonisrc.ts: ${(error as Error).message}. Expose a supported static providers array or complete Account Kit provider registration manually before running configure.`
    )
    return
  }

  await codemods.makeUsingStub(stubsRoot, 'config/account_kit.stub', {})

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
    await codemods.makeUsingStub(stubsRoot, `migrations/${name}.stub`, {
      migration: {
        ...schema,
        destination: command.app.makePath(`database/migrations/${timestamp + index}${suffix}`),
      },
    })
  }

  // Applications configured before the root export keep their registered legacy provider path.
  await codemods.updateRcFile((rcFile) => {
    if (!legacyProvider) rcFile.addProvider('adonisjs-account-kit/account_kit_provider')
    rcFile.addCommand('adonisjs-account-kit/commands')
  })

  // The generated config builds links from APP_URL. Declare it in start/env.ts so a missing
  // value fails at boot; defineEnvValidations leaves an existing declaration unchanged.
  await codemods.defineEnvValidations({
    leadingComment: 'Variables for adonisjs-account-kit',
    variables: { APP_URL: "Env.schema.string({ format: 'url', tld: false })" },
  })
}
