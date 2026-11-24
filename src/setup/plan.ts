import { migrationNames, buildMigrationSchema } from './migration_definitions.js'
import { orderMigrations } from './migration_order.js'
import { defaultMigrationDirectory } from './migration_paths.js'
import type { SetupChoices, SetupFileChange, SetupInspection, SetupPlan } from './types.js'
import { requireSetupChoices } from './parse.js'
import { parseSetupSource } from './ts_source.js'
import { hasEmailFlow, planSelectedManagedRoutes, addSetupDiagnostic, envName } from './shared.js'
import { collectSetupDiagnostics } from './validate.js'
import {
  generateEnvironmentTemplate,
  migrationContent,
  requireMigrationTemplatePath,
  addChange,
  recordOwnedChange,
} from './changes.js'
import {
  readRetainedSetupChoices,
  generateAllyConfigSource,
  generateAccountConfigSource,
} from './generated_sources.js'
import { planManagedFiles } from './plan_managed_files.js'
import {
  planRouteImport,
  planArrayImports,
  planRouterMiddleware,
  planServerProofMiddleware,
} from './source_edits.js'
import { planSessionConfigIntegration } from './plan_session_config.js'
import { planUserModel } from './plan_user_model.js'
import { planSession } from './plan_session.js'
import { planMail } from './plan_mail.js'
import { planDependencies } from './plan_dependencies.js'
import { planLimiter } from './plan_limiter.js'
import { planSummary } from './plan_summary.js'
import {
  IndirectEnvironmentValueError,
  resolveSelectedEnvironmentValue,
} from './selected_environment.js'
import type { SelectedSetupOrigins } from './diagnostics.js'

export async function planSetup(
  choices: SetupChoices,
  state: SetupInspection,
  options: {
    apply?: boolean
    production?: boolean
    timestamp?: number
    retirementImpact?: SetupPlan['retirementImpact']
    retirementMaintenanceWindow?: boolean
    runtimeInventoryUnavailable?: boolean
    /** Deployment values read for readiness and callback URLs; defaults to `process.env`. */
    env?: NodeJS.ProcessEnv
  } = {}
): Promise<SetupPlan> {
  choices = requireSetupChoices(choices)
  const env = options.env ?? process.env
  const selectedOrigins: SelectedSetupOrigins = { values: {}, errors: {} }
  const originNames = new Set<string>()
  if (hasEmailFlow(choices)) {
    originNames.add(choices.mail.backendOriginEnv)
    originNames.add(choices.mail.frontendOriginEnv)
    // Setup does not boot the app, so read mail references from `.env` like the origins.
    if (choices.mail.integration === 'adonisjs-mail')
      for (const name of [choices.mail.senderEnv, choices.mail.transportEnv])
        if (name) originNames.add(name)
  }
  if (choices.social.status === 'enabled') originNames.add(choices.social.callbackOriginEnv)
  await Promise.all(
    [...originNames]
      .filter((name) => envName.test(name))
      .map(async (name) => {
        try {
          selectedOrigins.values[name] = await resolveSelectedEnvironmentValue(
            state.root,
            name,
            env
          )
        } catch (error) {
          selectedOrigins.errors[name] = {
            message: error instanceof Error ? error.message : 'environment value is ambiguous',
            indirect: error instanceof IndirectEnvironmentValueError,
          }
        }
      })
  )
  const diagnostics = collectSetupDiagnostics(choices, state, {
    production: options.production ?? false,
    env,
    selectedOrigins,
    retirementImpact: options.retirementImpact ?? null,
    retirementMaintenanceWindow: options.retirementMaintenanceWindow ?? false,
    runtimeInventoryUnavailable: options.runtimeInventoryUnavailable ?? false,
  })
  // Generators assume valid choices. When validation has already reported an error for the
  // choices a generator reads, its failure leaves the file out instead of hiding that report.
  // Any other failure is a setup bug and still throws.
  const generateIfInputsAllow = async <T>(
    reads: string[],
    build: () => T | Promise<T>
  ): Promise<T | null> => {
    try {
      return await build()
    } catch (error) {
      if (
        diagnostics.some(
          ({ field, severity }) =>
            severity === 'error' && reads.some((prefix) => field.startsWith(prefix))
        )
      )
        return null
      throw error
    }
  }
  await planMail(choices, state, diagnostics, env)
  await planUserModel(choices, state, diagnostics)
  const changes: SetupFileChange[] = []
  const retainedChoices = readRetainedSetupChoices(state)
  const priorGenerated = state.existingChoices?.authentication
    ? state.existingChoices
    : retainedChoices
  const previousChoices = state.existingChoices
  let previousConfig = previousChoices ? generateAccountConfigSource(previousChoices) : null
  if (previousChoices) {
    // Older guided files omitted the diagnostic label. Match the entire old template
    // before treating the file as setup-owned.
    const legacyConfig = generateAccountConfigSource(previousChoices, {
      includeBackendOriginSetting: false,
    })
    if (state.files['config/account_kit.ts'] === legacyConfig) previousConfig = legacyConfig
  }
  recordOwnedChange(
    changes,
    state,
    'config/account_kit.ts',
    generateAccountConfigSource(choices),
    previousConfig,
    'Configure selected services, account access callbacks and notification adapters'
  )
  recordOwnedChange(
    changes,
    state,
    '.env.account-kit.example',
    generateEnvironmentTemplate(choices),
    state.existingChoices ? generateEnvironmentTemplate(state.existingChoices) : null,
    'Document deployment references'
  )
  await planSessionConfigIntegration(changes, state, choices, diagnostics, env)
  if (choices.social.status === 'enabled') {
    if (state.files['config/ally.ts'] === undefined) {
      const ally = await generateIfInputsAllow(['social.'], () => generateAllyConfigSource(choices))
      if (ally !== null)
        addChange(
          changes,
          state,
          'config/ally.ts',
          ally,
          'Configure selected Ally providers using deployment references and exact callbacks'
        )
    } else if (await ownsAllyConfig(state, choices)) {
      const ally = await generateIfInputsAllow(['social.'], () => generateAllyConfigSource(choices))
      if (ally !== null)
        recordOwnedChange(
          changes,
          state,
          'config/ally.ts',
          ally,
          state.files['config/ally.ts']!,
          'Configure selected Ally providers using deployment references and exact callbacks'
        )
    } else
      addSetupDiagnostic(
        diagnostics,
        'config/ally.ts',
        'Review the existing Ally configuration and add selected providers without replacing existing providers',
        'action'
      )
  }
  planManagedFiles(choices, state, diagnostics, changes, priorGenerated, retainedChoices)
  await planArrayImports(changes, state, diagnostics, 'adonisrc.ts', [
    ...(choices.managed.length ? ['@adonisjs/core/providers/vinejs_provider'] : []),
    '@adonisjs/lucid/database_provider',
    '@adonisjs/limiter/limiter_provider',
    '@kevinjohn/adonisjs-account-kit/account_kit_provider',
    ...(choices.managed.length ? ['@adonisjs/auth/auth_provider'] : []),
    ...(choices.social.status === 'enabled' ? ['@adonisjs/ally/ally_provider'] : []),
    ...(choices.authentication?.strategy === 'session' && choices.managed.length
      ? ['@adonisjs/session/session_provider', '@adonisjs/shield/shield_provider']
      : []),
    ...(hasEmailFlow(choices) && choices.mail.integration === 'adonisjs-mail'
      ? ['@adonisjs/mail/mail_provider']
      : []),
  ])
  if (choices.managed.length) {
    await planRouterMiddleware(
      changes,
      state,
      diagnostics,
      choices.authentication?.strategy === 'session'
    )
    await planServerProofMiddleware(changes, state, diagnostics)
    await planSession(choices, state, diagnostics, { ...options, env })
  }
  const migrationTimestamp = options.timestamp ?? Date.now()
  const schema = await generateIfInputsAllow(['user.'], () =>
    buildMigrationSchema(choices.user.table, choices.user.idType)
  )
  // Template reads sit outside `generateIfInputsAllow` and run without a schema: no reported choice explains
  // a read failure.
  const templates = new Map(
    await Promise.all(
      migrationNames.map(async (name) => [name, await requireMigrationTemplatePath(name)] as const)
    )
  )
  const migrationDirectory = state.migrationDirectory ?? defaultMigrationDirectory
  let migrations: ReturnType<typeof orderMigrations> = []
  if (state.migrationDirectoryError)
    addSetupDiagnostic(
      diagnostics,
      state.migrationDirectoryErrorField ?? 'config/database.ts',
      state.migrationDirectoryError
    )
  else
    try {
      migrations = orderMigrations(state.migrationNames, migrationTimestamp)
    } catch (error) {
      addSetupDiagnostic(diagnostics, migrationDirectory, (error as Error).message)
    }
  const migrationPaths = new Set<string>()
  for (const { name, filename } of migrations) {
    const template = templates.get(name)!
    if (schema === null) continue
    const path = `${migrationDirectory}/${filename}`
    migrationPaths.add(path)
    addChange(
      changes,
      state,
      path,
      await migrationContent(template, schema),
      `Review schema change ${name}; run migrations separately`
    )
  }
  if (choices.managed.length && choices.authentication)
    await planRouteImport(changes, state, diagnostics)
  // Commit the selection only after every dependent file. This preserves the previous
  // generated-content baseline when an interrupted application is replayed.
  recordOwnedChange(
    changes,
    state,
    'config/account_kit_setup.json',
    `${JSON.stringify(choices, null, 2)}\n`,
    state.files['config/account_kit_setup.json'] ?? null,
    'Persist six-pillar application choices without secrets'
  )
  // With the saved choices unchanged, a differing generated config or an existing migration was
  // edited by the owner or written by an earlier version. Keep it and say so; blocking would turn
  // every upgrade or config edit into a permanent `--check` failure.
  const choicesUnchanged =
    state.existingChoices !== null &&
    JSON.stringify(state.existingChoices) === JSON.stringify(choices)
  for (const change of changes) {
    const keptGenerated =
      change.path === 'config/account_kit.ts' || change.path === '.env.account-kit.example'
    const keptMigration = migrationPaths.has(change.path)
    if (change.action === 'conflict' && choicesUnchanged && (keptMigration || keptGenerated)) {
      change.action = 'unchanged'
      change.content = state.files[change.path]!
      addSetupDiagnostic(
        diagnostics,
        change.path,
        keptMigration
          ? 'Existing migration differs from this version; setup keeps it. Add a new migration for any schema change'
          : 'Existing file differs from what setup generates for the saved choices; setup keeps it',
        'action'
      )
    }
    if (change.action === 'conflict')
      addSetupDiagnostic(
        diagnostics,
        change.path,
        'Existing file differs. Resolve it manually; setup will not overwrite it'
      )
    if ((change.action === 'update' || change.action === 'create') && change.path.endsWith('.ts')) {
      try {
        await parseSetupSource(change.content)
      } catch {
        addSetupDiagnostic(
          diagnostics,
          change.path,
          'Proposed TypeScript is invalid; reconcile this application layout before setup writes files'
        )
      }
    }
  }
  let plannedEndpointLocations: Array<{ name: string; method: string; path: string }> = []
  try {
    plannedEndpointLocations = planSelectedManagedRoutes(choices).map(({ name, method, path }) => ({
      name,
      method,
      path,
    }))
  } catch {
    // Invalid choices are reported above; preview remains inspectable.
  }
  const endpointLocations = choices.authentication?.applicationRouteRevocation
    ? plannedEndpointLocations
    : []
  const endpoints = endpointLocations.map(({ name }) => name)
  const missingPackages = await planDependencies(choices, state, diagnostics)
  await planLimiter(state, diagnostics, env)
  return planSummary({
    choices,
    state,
    options,
    changes,
    diagnostics,
    endpoints,
    endpointLocations,
    missingPackages,
    env: {
      ...env,
      ...Object.fromEntries(
        Object.entries(selectedOrigins.values).map(([name, value]) => [name, value ?? undefined])
      ),
    },
  })
}

/** Setup owns `config/ally.ts` while it is exactly what setup generates for these or the saved choices. */
async function ownsAllyConfig(state: SetupInspection, choices: SetupChoices): Promise<boolean> {
  const existing = state.files['config/ally.ts']
  for (const selection of [choices, state.existingChoices]) {
    if (selection?.social.status !== 'enabled') continue
    try {
      if (generateAllyConfigSource(selection) === existing) return true
    } catch {
      // Saved choices this version cannot render do not claim the file.
    }
  }
  return false
}
