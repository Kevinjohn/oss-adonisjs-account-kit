import { migrationNames } from '../../configure.js'
import type { SetupChoices, SetupFileChange, SetupInspection, SetupPlan } from './types.js'
import { parseSetupChoices } from './parse.js'
import { parseSetupSource } from './ts_source.js'
import { hasEmailFlow, selectedManagedRoutes, diagnostic } from './shared.js'
import { validate } from './validate.js'
import { generatedEnv, migrationContent, addChange, ownedChange } from './changes.js'
import {
  retainedGeneratedChoices,
  allyConfigSource,
  accountConfigSource,
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
  choices = parseSetupChoices(choices)
  const env = options.env ?? process.env
  const diagnostics = validate(choices, state, {
    production: options.production ?? false,
    env,
    retirementImpact: options.retirementImpact ?? null,
    retirementMaintenanceWindow: options.retirementMaintenanceWindow ?? false,
    runtimeInventoryUnavailable: options.runtimeInventoryUnavailable ?? false,
  })
  await planMail(choices, state, diagnostics)
  await planUserModel(choices, state, diagnostics)
  const changes: SetupFileChange[] = []
  const retainedChoices = retainedGeneratedChoices(state)
  const priorGenerated = state.existingChoices?.authentication
    ? state.existingChoices
    : retainedChoices
  ownedChange(
    changes,
    state,
    'config/account_kit.ts',
    accountConfigSource(choices),
    state.existingChoices ? accountConfigSource(state.existingChoices) : null,
    'Configure selected services, policy and operational notification adapters'
  )
  ownedChange(
    changes,
    state,
    '.env.account-kit.example',
    generatedEnv(choices),
    state.existingChoices ? generatedEnv(state.existingChoices) : null,
    'Document deployment references'
  )
  await planSessionConfigIntegration(changes, state, choices, diagnostics)
  if (choices.social.status === 'enabled') {
    if (state.files['config/ally.ts'] === undefined)
      addChange(
        changes,
        state,
        'config/ally.ts',
        allyConfigSource(choices),
        'Configure selected Ally providers using deployment references and exact callbacks'
      )
    else
      diagnostic(
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
    'adonisjs-account-kit/account_kit_provider',
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
    await planSession(choices, state, diagnostics, options)
  }
  const migrationTimestamp = options.timestamp ?? Date.now()
  for (const [index, name] of migrationNames.entries()) {
    const suffix = `_account_kit_${name}.ts`
    const existing = state.migrationNames.find((filename) => filename.endsWith(suffix))
    const path = `database/migrations/${existing ?? `${migrationTimestamp + index}${suffix}`}`
    const content = await migrationContent(name, choices)
    addChange(
      changes,
      state,
      path,
      content,
      `Review schema change ${name}; run migrations separately`
    )
  }
  if (choices.managed.length && choices.authentication)
    await planRouteImport(changes, state, diagnostics)
  // Commit the selection only after every dependent file. This preserves the previous
  // generated-content baseline when an interrupted application is replayed.
  ownedChange(
    changes,
    state,
    'config/account_kit_setup.json',
    `${JSON.stringify(choices, null, 2)}\n`,
    state.files['config/account_kit_setup.json'] ?? null,
    'Persist six-pillar application choices without secrets'
  )
  for (const change of changes) {
    if (change.action === 'conflict')
      diagnostic(
        diagnostics,
        change.path,
        'Existing file differs. Resolve it manually; setup will not overwrite it'
      )
    if ((change.action === 'update' || change.action === 'create') && change.path.endsWith('.ts')) {
      try {
        await parseSetupSource(change.content)
      } catch {
        diagnostic(
          diagnostics,
          change.path,
          'Proposed TypeScript is invalid; reconcile this application layout before setup writes files'
        )
      }
    }
  }
  let plannedEndpointLocations: Array<{ name: string; method: string; path: string }> = []
  try {
    plannedEndpointLocations = selectedManagedRoutes(choices).map(({ name, method, path }) => ({
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
  await planLimiter(state, diagnostics)
  return planSummary({
    choices,
    state,
    options,
    changes,
    diagnostics,
    endpoints,
    endpointLocations,
    missingPackages,
    env,
  })
}
