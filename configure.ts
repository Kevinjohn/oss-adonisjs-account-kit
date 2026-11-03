import { RuntimeException } from '@adonisjs/core/exceptions'
import { readdir } from 'node:fs/promises'
import type { CodeTransformer } from '@adonisjs/assembler/code_transformer'
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

const providerPath = '@kevinjohn/adonisjs-account-kit/account_kit_provider'

class UnsupportedProvidersConfiguration extends Error {}
class UnsupportedConfigShape extends Error {}

type RcNode = {
  getKindName(): string
  getText(): string
  getArguments?(): RcNode[]
  getExpression?(): RcNode
  getProperty?(name: string): RcNode | undefined
  getProperties?(): RcNode[]
  getName?(): string
  getNameNode?(): RcNode
  getInitializer?(): RcNode | undefined
  getElements?(): RcNode[]
  getBody?(): RcNode
  getStatements?(): RcNode[]
  getLiteralValue?(): string
}
type AssemblerProject = CodeTransformer['project']

/**
 * Inspect the same defineConfig call and provider entry forms consumed by Assembler's RC
 * transformer. Returning false means no registered provider was found in the inspectable configuration.
 */
function hasRegisteredProvider(project: AssemblerProject, rcPath: string): boolean {
  const rcFile = project.getSourceFile(rcPath)
  if (!rcFile) throw new Error('could not load adonisrc.ts from the Assembler TypeScript project')
  if (project.getProgram().getSyntacticDiagnostics(rcFile).length)
    throw new Error('adonisrc.ts contains TypeScript syntax errors')

  const call = (rcFile.getDescendants() as unknown as RcNode[]).find((node) => {
    if (node.getKindName() !== 'CallExpression') return false
    return node.getExpression?.().getText() === 'defineConfig'
  })
  if (!call) throw new UnsupportedConfigShape('could not locate the defineConfig call')
  const config = call.getArguments?.()[0]
  if (!config || config.getKindName() !== 'ObjectLiteralExpression')
    throw new UnsupportedConfigShape('defineConfig does not receive a static object literal')

  const properties = config.getProperties?.() ?? []
  if (
    properties.some((property) => property.getNameNode?.().getKindName() === 'ComputedPropertyName')
  ) {
    throw new UnsupportedConfigShape('computed config properties cannot be inspected safely')
  }

  let lastSpreadIndex = -1
  for (const [index, property] of properties.entries()) {
    if (property.getKindName() === 'SpreadAssignment') lastSpreadIndex = index
  }
  const propertiesAfterLastSpread = properties.slice(lastSpreadIndex + 1).reverse()
  const findProperty = (name: string) =>
    lastSpreadIndex >= 0
      ? propertiesAfterLastSpread.find((property) => property.getName?.() === name)
      : config.getProperty?.(name)
  if (
    lastSpreadIndex >= 0 &&
    !['providers', 'commands'].every(
      (name) => findProperty(name)?.getKindName() === 'PropertyAssignment'
    )
  ) {
    throw new UnsupportedConfigShape(
      'a config with object spreads must explicitly expose providers and commands after its last spread'
    )
  }

  const providersProperty = findProperty('providers')
  const commandsProperty = findProperty('commands')
  if (
    commandsProperty &&
    (commandsProperty.getKindName() !== 'PropertyAssignment' ||
      commandsProperty.getInitializer?.()?.getKindName() !== 'ArrayLiteralExpression')
  ) {
    throw new UnsupportedConfigShape('the commands property is not a static array assignment')
  }

  if (!providersProperty) return false
  if (providersProperty.getKindName() !== 'PropertyAssignment')
    throw new UnsupportedProvidersConfiguration(
      'the providers property is not a static array assignment'
    )

  const providersArray = providersProperty.getInitializer?.()
  if (!providersArray || providersArray.getKindName() !== 'ArrayLiteralExpression')
    throw new UnsupportedProvidersConfiguration('the providers property is not a static array')

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

  let providerFound = false
  for (const entry of providersArray.getElements?.() ?? []) {
    const isProviderObject = entry.getKindName() === 'ObjectLiteralExpression'
    let loader: RcNode | undefined = entry
    if (isProviderObject) {
      const entryProperties = entry.getProperties?.() ?? []
      if (
        entryProperties.some(
          (property) => property.getNameNode?.().getKindName() === 'ComputedPropertyName'
        )
      ) {
        throw new UnsupportedProvidersConfiguration(
          'computed provider object properties cannot be inspected safely'
        )
      }

      let entryLastSpreadIndex = -1
      for (const [index, property] of entryProperties.entries()) {
        if (property.getKindName() === 'SpreadAssignment') entryLastSpreadIndex = index
      }
      const fileProperty =
        entryLastSpreadIndex >= 0
          ? entryProperties
              .slice(entryLastSpreadIndex + 1)
              .reverse()
              .find(
                (property) =>
                  property.getKindName() === 'PropertyAssignment' && property.getName?.() === 'file'
              )
          : entry.getProperty?.('file')
      loader =
        fileProperty?.getKindName() === 'PropertyAssignment'
          ? fileProperty.getInitializer?.()
          : undefined
    }
    const path = loader && importPathFromArrow(loader)
    if (!path) {
      const message = isProviderObject
        ? 'a providers object must have a static file lazy import'
        : 'a providers entry is not a supported lazy import'
      throw new UnsupportedProvidersConfiguration(message)
    }
    if (path === providerPath) providerFound = true
  }
  return providerFound
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
 * Runs on `node ace add @kevinjohn/adonisjs-account-kit` or `node ace configure @kevinjohn/adonisjs-account-kit`: writes
 * `config/account_kit.ts`, generates the migrations and registers the provider and commands. Never
 * overwrites existing files. Flags: `--users-table` and `--user-id-type` (`integer`, `string` or
 * `uuid`). For an unsupported dynamic `providers` expression, ensure exactly one current
 * Account Kit provider export is registered, then rerun with `--provider-registered` to leave that
 * expression unchanged. The RC config must be an object literal so Assembler can add the package
 * command while preserving the existing entries.
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

  let registeredProvider: boolean | undefined
  try {
    const project = await codemods.getTsMorphProject()
    if (!project) throw new Error('the Assembler TypeScript project is unavailable')
    registeredProvider = hasRegisteredProvider(project, command.app.makePath('adonisrc.ts'))
  } catch (error) {
    if (error instanceof UnsupportedConfigShape) {
      command.exitCode = 1
      command.logger.logError(
        `Unable to inspect adonisrc.ts: ${error.message}. Pass the config as an object literal, preserving its fields and exposing commands and providers explicitly (for example, defineConfig({ ...applicationConfig, commands: [...(applicationConfig.commands ?? [])], providers: applicationConfig.providers })). Ensure the provider list registers Account Kit exactly once: retain @kevinjohn/adonisjs-account-kit/account_kit_provider if present, and add it only if it is not registered. Then rerun node ace configure @kevinjohn/adonisjs-account-kit --provider-registered.`
      )
      return
    }
    if (error instanceof UnsupportedProvidersConfiguration) {
      if (command.parsedFlags['provider-registered'] === true) {
        command.logger.info(
          'Assuming adonisrc.ts already registers the Account Kit provider; provider registration will not be changed.'
        )
      } else {
        command.exitCode = 1
        command.logger.logError(
          `Unable to inspect adonisrc.ts providers: ${error.message}. Ensure the dynamic provider list registers Account Kit exactly once: retain @kevinjohn/adonisjs-account-kit/account_kit_provider if present, and add it only if it is not registered. Then rerun node ace configure @kevinjohn/adonisjs-account-kit --provider-registered. If defineConfig receives a config variable, first expose it as an object literal with its providers property, as described in the install guide. This flag confirms that registration is already complete; configure will leave providers unchanged.`
        )
        return
      }
    } else {
      command.exitCode = 1
      command.logger.logError(`Unable to inspect adonisrc.ts: ${(error as Error).message}.`)
      return
    }
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

  // Keep an existing registration rather than adding the provider twice.
  await codemods.updateRcFile((rcFile) => {
    if (registeredProvider === false)
      rcFile.addProvider('@kevinjohn/adonisjs-account-kit/account_kit_provider')
    rcFile.addCommand('@kevinjohn/adonisjs-account-kit/commands')
  })

  // The generated config builds links from APP_URL. Declare it in start/env.ts so a missing
  // value fails at boot; defineEnvValidations leaves an existing declaration unchanged.
  await codemods.defineEnvValidations({
    leadingComment: 'Variables for @kevinjohn/adonisjs-account-kit',
    variables: { APP_URL: "Env.schema.string({ format: 'url', tld: false })" },
  })
}
