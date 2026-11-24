import { RuntimeException } from '@adonisjs/core/exceptions'
import {
  E_ACCOUNT_KIT_INVALID_SETUP_SOURCE,
  E_ACCOUNT_KIT_UNSUPPORTED_CONFIG_SHAPE,
  E_ACCOUNT_KIT_UNSUPPORTED_PROVIDERS_CONFIGURATION,
} from './src/errors.js'
import type { CodeTransformer } from '@adonisjs/assembler/code_transformer'
import { relative, resolve, sep } from 'node:path'
import type Configure from '@adonisjs/core/commands/configure'
import type * as TypeScript from 'typescript'
import { buildMigrationSchema } from './src/setup/migration_definitions.js'
import { inspectMigrationDirectory } from './src/setup/migration_paths.js'
import { orderMigrations } from './src/setup/migration_order.js'
import { readRegularFile } from './src/setup/safe_path.js'
import { hasRegisteredCommand } from './src/setup/commands_inspection.js'
import { inspectProviders } from './src/setup/providers_inspection.js'
import { parseSetupSource, walk, type SetupSource } from './src/setup/ts_source.js'
import { stubsRoot } from './stubs/main.js'

export {
  migrationNames,
  buildMigrationSchema as migrationSchema,
  type UserIdType,
} from './src/setup/migration_definitions.js'

const providerPath = '@kevinjohn/adonisjs-account-kit/account_kit_provider'

type AssemblerProject = CodeTransformer['project']

/**
 * Inspect the same defineConfig call and provider entry forms consumed by Assembler's RC
 * transformer. Returning false means no registered provider was found in the inspectable configuration.
 */
async function hasRegisteredProvider(project: AssemblerProject, rcPath: string): Promise<boolean> {
  const rcFile = project.getSourceFile(rcPath)
  if (!rcFile)
    throw new RuntimeException('could not load adonisrc.ts from the Assembler TypeScript project')
  if (project.getProgram().getSyntacticDiagnostics(rcFile).length)
    throw new RuntimeException('adonisrc.ts contains TypeScript syntax errors')
  let source: SetupSource
  try {
    source = await parseSetupSource(rcFile.getFullText())
  } catch (error) {
    if (error instanceof E_ACCOUNT_KIT_INVALID_SETUP_SOURCE)
      throw new RuntimeException('adonisrc.ts contains TypeScript syntax errors')
    throw error
  }
  const { ts, file } = source

  let call: TypeScript.CallExpression | undefined
  walk(source, (node) => {
    if (!call && ts.isCallExpression(node) && node.expression.getText(file) === 'defineConfig')
      call = node
  })
  if (!call)
    throw new E_ACCOUNT_KIT_UNSUPPORTED_CONFIG_SHAPE('could not locate the defineConfig call')
  const config = call.arguments[0]
  if (!config || !ts.isObjectLiteralExpression(config))
    throw new E_ACCOUNT_KIT_UNSUPPORTED_CONFIG_SHAPE(
      'defineConfig does not receive a static object literal'
    )

  // A property's name as written, so `'providers'` (quoted) is not the providers property.
  const readPropertyName = (property: TypeScript.ObjectLiteralElementLike) =>
    ts.isSpreadAssignment(property) ? undefined : property.name.getText(file)
  const isComputed = (property: TypeScript.ObjectLiteralElementLike) =>
    !ts.isSpreadAssignment(property) && ts.isComputedPropertyName(property.name)
  const locateLastSpread = (object: TypeScript.ObjectLiteralExpression) =>
    object.properties.findLastIndex((property) => ts.isSpreadAssignment(property))

  if (config.properties.some(isComputed)) {
    throw new E_ACCOUNT_KIT_UNSUPPORTED_CONFIG_SHAPE(
      'computed config properties cannot be inspected safely'
    )
  }

  const configSpread = locateLastSpread(config)
  // After a spread, only properties written after the last spread are known.
  const findProperty = (object: TypeScript.ObjectLiteralExpression, name: string) =>
    configSpread >= 0
      ? object.properties
          .slice(configSpread + 1)
          .findLast((property) => readPropertyName(property) === name)
      : object.properties.find((property) => readPropertyName(property) === name)
  const findFile = (entry: TypeScript.ObjectLiteralExpression, name: string) => {
    const entrySpread = locateLastSpread(entry)
    return entrySpread >= 0
      ? entry.properties
          .slice(entrySpread + 1)
          .findLast(
            (property) => ts.isPropertyAssignment(property) && readPropertyName(property) === name
          )
      : entry.properties.find((property) => readPropertyName(property) === name)
  }
  if (
    configSpread >= 0 &&
    !['providers', 'commands'].every((name) => {
      const property = findProperty(config, name)
      return property !== undefined && ts.isPropertyAssignment(property)
    })
  ) {
    throw new E_ACCOUNT_KIT_UNSUPPORTED_CONFIG_SHAPE(
      'a config with object spreads must explicitly expose providers and commands after its last spread'
    )
  }

  const commandsProperty = findProperty(config, 'commands')
  if (
    commandsProperty &&
    (!ts.isPropertyAssignment(commandsProperty) ||
      !ts.isArrayLiteralExpression(commandsProperty.initializer))
  ) {
    throw new E_ACCOUNT_KIT_UNSUPPORTED_CONFIG_SHAPE(
      'the commands property is not a static array assignment'
    )
  }

  const providers = inspectProviders(source, config, { config: findProperty, entry: findFile })
  if (providers.status === 'absent') return false
  if (providers.status === 'not-assignment')
    throw new E_ACCOUNT_KIT_UNSUPPORTED_PROVIDERS_CONFIGURATION(
      'the providers property is not a static array assignment'
    )
  if (providers.status === 'not-array')
    throw new E_ACCOUNT_KIT_UNSUPPORTED_PROVIDERS_CONFIGURATION(
      'the providers property is not a static array'
    )

  let providerFound = false
  for (const entry of providers.entries) {
    if (
      entry.isObject &&
      ts.isObjectLiteralExpression(entry.node) &&
      entry.node.properties.some(isComputed)
    ) {
      throw new E_ACCOUNT_KIT_UNSUPPORTED_PROVIDERS_CONFIGURATION(
        'computed provider object properties cannot be inspected safely'
      )
    }
    if (!entry.path) {
      const message = entry.isObject
        ? 'a providers object must have a static file lazy import'
        : 'a providers entry is not a supported lazy import'
      throw new E_ACCOUNT_KIT_UNSUPPORTED_PROVIDERS_CONFIGURATION(message)
    }
    if (entry.path === providerPath) providerFound = true
  }
  return providerFound
}

/**
 * Runs on `node ace add @kevinjohn/adonisjs-account-kit` or `node ace configure @kevinjohn/adonisjs-account-kit`: writes
 * `config/account_kit.ts`, generates the migrations and registers the provider and commands. Never
 * overwrites existing files. Flags: `--users-table` and `--user-id-type` (`integer`, `string` or
 * `uuid`); `--migration-directory` confirms an otherwise uninspectable Lucid path or selects one
 * of several configured paths. For an unsupported dynamic `providers` expression, ensure exactly
 * one current Account Kit provider export is registered, then rerun with `--provider-registered`
 * to leave that
 * expression unchanged. The RC config must be an object literal so Assembler can add the package
 * command while preserving the existing entries.
 */
export async function configure(command: Configure) {
  let schema: ReturnType<typeof buildMigrationSchema>
  try {
    schema = buildMigrationSchema(
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
  let registeredCommand = false
  try {
    const project = await codemods.getTsMorphProject()
    if (!project) throw new RuntimeException('the Assembler TypeScript project is unavailable')
    const rcPath = command.app.makePath('adonisrc.ts')
    registeredProvider = await hasRegisteredProvider(project, rcPath)
    const rcFile = project.getSourceFile(rcPath)
    if (!rcFile)
      throw new RuntimeException('could not load adonisrc.ts from the Assembler TypeScript project')
    registeredCommand = await hasRegisteredCommand(
      rcFile.getFullText(),
      '@kevinjohn/adonisjs-account-kit/commands'
    )
  } catch (error) {
    if (error instanceof E_ACCOUNT_KIT_UNSUPPORTED_CONFIG_SHAPE) {
      command.exitCode = 1
      command.logger.logError(
        `Unable to inspect adonisrc.ts: ${error.message}. Pass the config as an object literal, preserving its fields and exposing commands and providers explicitly (for example, defineConfig({ ...applicationConfig, commands: [...(applicationConfig.commands ?? [])], providers: applicationConfig.providers })). Ensure the provider list registers Account Kit exactly once: retain @kevinjohn/adonisjs-account-kit/account_kit_provider if present, and add it only if it is not registered. Then rerun node ace configure @kevinjohn/adonisjs-account-kit --provider-registered.`
      )
      return
    }
    if (error instanceof E_ACCOUNT_KIT_UNSUPPORTED_PROVIDERS_CONFIGURATION) {
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

  const root = resolve(command.app.makePath(''))
  let directory: Awaited<ReturnType<typeof inspectMigrationDirectory>>
  let migrations: ReturnType<typeof orderMigrations>
  try {
    directory = await inspectMigrationDirectory(
      root,
      (await readRegularFile(root, relative(root, command.app.configPath('database.ts')))) ?? '',
      command.parsedFlags['migration-directory'],
      process.env,
      relative(root, command.app.migrationsPath()).split(sep).join('/')
    )
    migrations = orderMigrations(directory.names, Date.now())
  } catch (error) {
    command.exitCode = 1
    command.logger.logError(
      `${(error as Error).message}. Nothing was written: config/account_kit.ts, the migrations, the provider and the commands are unchanged. Rerun configure after resolving the migration destination.`
    )
    return
  }

  await codemods.makeUsingStub(stubsRoot, 'config/account_kit.stub', {})
  for (const { name, filename, existing } of migrations) {
    if (existing) {
      command.logger.info(`Skipped ${directory.path}/${filename}`)
      continue
    }
    await codemods.makeUsingStub(stubsRoot, `migrations/${name}.stub`, {
      migration: {
        ...schema,
        destination: resolve(root, directory.path, filename),
      },
    })
  }

  // Keep an existing registration rather than adding the provider twice.
  await codemods.updateRcFile((rcFile) => {
    if (registeredProvider === false)
      rcFile.addProvider('@kevinjohn/adonisjs-account-kit/account_kit_provider')
    if (!registeredCommand) rcFile.addCommand('@kevinjohn/adonisjs-account-kit/commands')
  })

  // The generated config builds links from FRONTEND_URL, or APP_URL when it is unset. Declare them
  // in start/env.ts so a missing APP_URL fails at boot; defineEnvValidations leaves an existing
  // declaration unchanged.
  await codemods.defineEnvValidations({
    leadingComment: 'Variables for @kevinjohn/adonisjs-account-kit',
    variables: {
      APP_URL: "Env.schema.string({ format: 'url', tld: false })",
      FRONTEND_URL: "Env.schema.string.optional({ format: 'url', tld: false })",
    },
  })
}
