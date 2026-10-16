import { lstat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { safeSetupPath } from './safe_path.js'
import { fileURLToPath } from 'node:url'
import { migrationNames, migrationSchema } from '../../configure.js'
import type {
  SetupChoices,
  SetupDiagnostic,
  SetupFeature,
  SetupFileChange,
  SetupInspection,
  SetupPlan,
} from './types.js'
import { featureNames } from './types.js'
import { parseSetupChoices } from './parse.js'
import { planManagedRoutes, type ExistingRoute, type ManagedRoute } from '../http/routes.js'
import { createActionUrls } from '../notifications.js'
import { stripSourceComments } from './source_text.js'
import { resolveSelectedEnvironment, selectedSessionEnvironment } from './session_env.js'
import {
  defaultExpression,
  defaultImportName,
  directProperty,
  exactCall,
  exportedObject,
  hasUnsafeObjectEntries,
  hasUnsafeBindingReferences,
  importedName,
  parseSetupSource,
  safeEnvGetter,
  topLevelConfig,
  walk,
  type SetupSource,
} from './ts_source.js'
import type * as TypeScript from 'typescript'

const emailDestinations: Partial<Record<SetupFeature, keyof SetupChoices['mail']['destinations']>> =
  {
    registration: 'emailVerification',
    emailVerification: 'emailVerification',
    passwordReset: 'passwordReset',
    invitations: 'invitation',
    emailPasswordManagement: 'emailChange',
  }

function hasEmailFlow(choices: SetupChoices): boolean {
  return choices.features.some((feature) => feature in emailDestinations)
}

const envName = /^[A-Z][A-Z0-9_]*$/
const sqlName = /^[A-Za-z_][A-Za-z0-9_]*$/
const routePrefix = /^\/[A-Za-z0-9/_-]*$/

function selectedManagedRoutes(
  choices: SetupChoices,
  existing: readonly ExistingRoute[] = []
): ManagedRoute[] {
  if (!choices.managed.length || !choices.authentication) return []
  return planManagedRoutes(
    {
      prefix: choices.routePrefix,
      strategy: choices.authentication.strategy,
      enabled: choices.managed,
      except: choices.managedExcept ?? [],
    },
    existing
  )
}

function diagnostic(
  diagnostics: SetupDiagnostic[],
  field: string,
  message: string,
  severity: SetupDiagnostic['severity'] = 'error'
) {
  diagnostics.push({ field, message, severity })
}

function validateOrigin(
  diagnostics: SetupDiagnostic[],
  field: string,
  variable: string,
  production: boolean
) {
  if (!envName.test(variable)) {
    diagnostic(
      diagnostics,
      field,
      'Use an uppercase environment variable name, not a URL or secret'
    )
    return
  }
  const value = process.env[variable]
  if (!value) {
    diagnostic(diagnostics, field, `${variable} must be set before readiness can pass`, 'action')
    return
  }
  try {
    const parsed = new URL(value)
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error('origin must not include credentials, query or fragment')
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('HTTP(S) is required')
    if (production && parsed.protocol !== 'https:') {
      diagnostic(diagnostics, field, `${variable} must use HTTPS in production`)
    } else if (
      parsed.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    ) {
      diagnostic(diagnostics, field, `${variable} may use HTTP only for loopback development`)
    }
  } catch {
    diagnostic(diagnostics, field, `${variable} must be a valid trusted HTTP(S) origin`)
  }
}

function validate(
  choices: SetupChoices,
  state: SetupInspection,
  production: boolean,
  retirementImpact: SetupPlan['retirementImpact'],
  retirementMaintenanceWindow: boolean
) {
  const diagnostics: SetupDiagnostic[] = []
  if (choices.version !== 1) diagnostic(diagnostics, 'version', 'Supported setup version is 1')
  if (!['services', 'managed'].includes(choices.mode))
    diagnostic(diagnostics, 'mode', 'Choose services or managed')
  if (!Array.isArray(choices.features) || choices.features.some((x) => !featureNames.includes(x)))
    diagnostic(diagnostics, 'features', `Choose from ${featureNames.join(', ')}`)
  if (new Set(choices.features).size !== choices.features.length)
    diagnostic(diagnostics, 'features', 'List each feature once')
  if (!Array.isArray(choices.managed) || choices.managed.some((x) => !featureNames.includes(x)))
    diagnostic(diagnostics, 'managed', `Choose from ${featureNames.join(', ')}`)
  if (new Set(choices.managed).size !== choices.managed.length)
    diagnostic(diagnostics, 'managed', 'List each managed feature once')
  if (choices.managed.some((x) => !choices.features.includes(x)))
    diagnostic(
      diagnostics,
      'managed',
      'Every managed feature must have its underlying service enabled'
    )
  if (choices.mode === 'services' && choices.managed.length)
    diagnostic(diagnostics, 'managed', 'Services mode cannot mount managed endpoints')
  if (
    !routePrefix.test(choices.routePrefix) ||
    choices.routePrefix === '/' ||
    choices.routePrefix.endsWith('/') ||
    choices.routePrefix.includes('//')
  )
    diagnostic(
      diagnostics,
      'routePrefix',
      'Use a non-root absolute path without a query or fragment'
    )
  let managedRoutes: ManagedRoute[] = []
  try {
    managedRoutes = selectedManagedRoutes(choices)
    const allowedExcept = planManagedRoutes({
      prefix: choices.routePrefix,
      strategy: choices.authentication?.strategy ?? 'session',
      enabled: choices.managed,
    }).map(({ name }) => name)
    if (
      new Set(choices.managedExcept ?? []).size !== (choices.managedExcept ?? []).length ||
      (choices.managedExcept ?? []).some((name) => !allowedExcept.includes(name))
    )
      diagnostic(
        diagnostics,
        'managedExcept',
        'Exclude each selected managed endpoint at most once'
      )
  } catch {
    diagnostic(
      diagnostics,
      'managedExcept',
      'Select only known endpoint names for the selected strategy and managed groups'
    )
  }
  if (managedRoutes.length) {
    const existing = state.routeDefinitions.flatMap((route) =>
      route.method === 'ANY'
        ? (['GET', 'POST', 'PATCH', 'DELETE'] as const).map((method) => ({ ...route, method }))
        : [route]
    )
    try {
      selectedManagedRoutes(choices, existing)
    } catch (error) {
      diagnostic(
        diagnostics,
        'routePrefix',
        `${(error as Error).message}; exclude the selected endpoint or change the application route`
      )
    }
  }
  if (choices.user.connection !== 'default')
    diagnostic(diagnostics, 'user.connection', 'Only the default Lucid connection is supported')
  if (state.connection === 'unsupported')
    diagnostic(diagnostics, 'database.connection', 'Application uses a non-default connection')
  if (state.database === 'unsupported')
    diagnostic(diagnostics, 'database.client', 'Only SQLite and PostgreSQL 16 are supported')
  if (state.database === 'unknown')
    diagnostic(diagnostics, 'database.client', 'Verify SQLite or PostgreSQL 16 client', 'action')
  if (!sqlName.test(choices.user.table))
    diagnostic(diagnostics, 'user.table', 'Use a plain SQL identifier')
  if (!['lucid', 'custom'].includes(choices.user.adapter))
    diagnostic(diagnostics, 'user.adapter', 'Choose lucid or custom')
  if (!['integer', 'string', 'uuid'].includes(choices.user.idType))
    diagnostic(diagnostics, 'user.idType', 'Choose integer, string or uuid')
  if (
    choices.user.primaryKey !== 'id' ||
    choices.user.emailColumn !== 'email' ||
    choices.user.passwordColumn !== 'password' ||
    choices.user.verifiedColumn !== 'email_verified_at'
  )
    diagnostic(
      diagnostics,
      'user',
      'Only the physical id, email, password and email_verified_at columns are supported'
    )
  if (
    !/^#models\/[A-Za-z_][A-Za-z0-9_/]*$/.test(choices.user.model) ||
    choices.user.model.includes('//')
  )
    diagnostic(diagnostics, 'user.model', 'Use an application #models/ import with a safe path')
  if (choices.user.adapter === 'custom')
    diagnostic(
      diagnostics,
      'user.adapter',
      'Verify custom adapter normalization, unique email, password hashing, transactions and row locking before activation',
      'action'
    )
  if (choices.user.adapter === 'custom' && !state.files['app/services/account_kit_users.ts'])
    diagnostic(diagnostics, 'user.adapter', 'Provide #services/account_kit_users before activation')
  if (choices.managed.length && !choices.authentication)
    diagnostic(
      diagnostics,
      'authentication',
      'Managed endpoints require one existing guard, including when login is application-owned'
    )
  if (choices.features.includes('authentication') && !choices.authentication)
    diagnostic(diagnostics, 'authentication', 'Authentication requires a selected existing guard')
  if (choices.authentication) {
    if (!['session', 'access_tokens'].includes(choices.authentication.strategy))
      diagnostic(diagnostics, 'authentication.strategy', 'Choose session or access_tokens')
    if (!state.guards.includes(choices.authentication.guard))
      diagnostic(
        diagnostics,
        'authentication.guard',
        'Named existing guard was not found in config/auth.ts; add it yourself before activation'
      )
    else if (
      state.guardStrategies[choices.authentication.guard] !== choices.authentication.strategy
    )
      diagnostic(
        diagnostics,
        'authentication.guard',
        'Selected guard must use the matching conventional sessionGuard or tokensGuard driver'
      )
    else if (state.guardModels[choices.authentication.guard] !== choices.user.model)
      diagnostic(
        diagnostics,
        'authentication.guard',
        'Selected guard must load the selected user model through its conventional user provider'
      )
    if (choices.authentication.strategy === 'session') {
      if (!choices.authentication.session)
        diagnostic(
          diagnostics,
          'authentication.session',
          'Describe cookie, CSRF, origin and session storage checks'
        )
      else if (production && Object.values(choices.authentication.session).some((v) => v !== true))
        diagnostic(
          diagnostics,
          'authentication.session',
          'Production requires secure cookie, CSRF, trusted origin and persistent storage verification'
        )
    } else if (!choices.authentication.token?.revocation)
      diagnostic(
        diagnostics,
        'authentication.token.revocation',
        'Token revocation must be configured'
      )
    if (!choices.authentication.applicationRouteRevocation)
      diagnostic(
        diagnostics,
        'authentication.applicationRouteRevocation',
        'Document and verify revocation on application-owned protected routes'
      )
  }
  const p = choices.policy.password
  if (
    !Number.isInteger(p.minLength) ||
    p.minLength < 8 ||
    p.minLength > 256 ||
    (p.maxLength !== null &&
      (!Number.isInteger(p.maxLength) || p.maxLength < p.minLength || p.maxLength > 256)) ||
    !Number.isInteger(p.minScore) ||
    p.minScore < 0 ||
    p.minScore > 4
  )
    diagnostic(
      diagnostics,
      'policy.password',
      'Use minLength 8–256, maxLength null or minLength–256, and minScore 0–4'
    )
  for (const key of ['letters', 'mixedCase', 'numbers', 'symbols'] as const) {
    if (typeof p[key] !== 'boolean')
      diagnostic(diagnostics, `policy.password.${key}`, 'Use a boolean')
  }
  if (choices.policy.registration === 'open' && !choices.features.includes('registration'))
    diagnostic(
      diagnostics,
      'policy.registration',
      'Open registration requires registration to be enabled'
    )
  if (
    choices.managed.includes('registration') &&
    !choices.managedExcept?.includes('auth.signup') &&
    choices.policy.registration !== 'open'
  )
    diagnostic(
      diagnostics,
      'policy.registration',
      'Managed public signup requires open registration; use an application-owned route for application admission or omit managed signup when closed'
    )
  const protectedFields = new Set([
    'id',
    'email',
    'password',
    'passwordhash',
    'password_hash',
    'unverifiedemail',
    'unverified_email',
    'emailverifiedat',
    'email_verified_at',
    'role',
    'roles',
    'isadmin',
    'accesstokens',
    'credentialschangedat',
    '__proto__',
    'prototype',
    'constructor',
  ])
  const fieldNames = new Set<string>()
  for (const [index, field] of choices.policy.registrationFields.entries()) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name) ||
      protectedFields.has(field.name.toLowerCase())
    )
      diagnostic(
        diagnostics,
        `policy.registrationFields.${index}.name`,
        'Field must be a safe application-owned property'
      )
    if (fieldNames.has(field.name))
      diagnostic(
        diagnostics,
        `policy.registrationFields.${index}.name`,
        'Registration fields must be unique'
      )
    fieldNames.add(field.name)
    if (!['string', 'number', 'boolean'].includes(field.type))
      diagnostic(
        diagnostics,
        `policy.registrationFields.${index}.type`,
        'Choose string, number or boolean'
      )
    if (
      field.maxLength !== undefined &&
      (field.type !== 'string' ||
        !Number.isInteger(field.maxLength) ||
        field.maxLength < 1 ||
        field.maxLength > 1024)
    )
      diagnostic(
        diagnostics,
        `policy.registrationFields.${index}.maxLength`,
        'Use maxLength 1–1024 for a string field'
      )
  }
  if (choices.features.includes('invitations') && !choices.policy.invitationPermissionHook)
    diagnostic(
      diagnostics,
      'policy.invitationPermissionHook',
      'Invitation permission callback must be supplied; missing permission denies access'
    )
  if (
    (choices.policy.accessRestrictionHook || choices.features.includes('invitations')) &&
    !state.files['app/services/account_kit_policy.ts']
  )
    diagnostic(
      diagnostics,
      'policy',
      'Provide #services/account_kit_policy callbacks before activation'
    )
  else if (choices.policy.accessRestrictionHook || choices.features.includes('invitations'))
    diagnostic(
      diagnostics,
      'policy.callbacks',
      'Verify the application-owned policy callbacks implement the selected access and invitation contracts at runtime',
      'action'
    )
  if (choices.authentication && !choices.policy.accessRestrictionHook)
    diagnostic(
      diagnostics,
      'policy.accessRestrictionHook',
      'Supply a restricted-account callback for login and managed access'
    )
  if (choices.policy.verificationRequired && !choices.features.includes('emailVerification'))
    diagnostic(
      diagnostics,
      'policy.verificationRequired',
      'Verification-gated access requires email verification'
    )
  if (
    choices.features.includes('emailPasswordManagement') &&
    !choices.features.includes('emailVerification')
  )
    diagnostic(diagnostics, 'features', 'Email/password management requires email verification')
  if (choices.features.includes('registration') && !choices.features.includes('emailVerification'))
    diagnostic(diagnostics, 'features', 'Registration requires the email verification service')
  if (choices.policy.verificationRequired) {
    for (const action of ['logout', 'verificationResend', 'passwordReset'] as const) {
      if (!choices.policy.unverifiedActions.includes(action))
        diagnostic(
          diagnostics,
          'policy.unverifiedActions',
          `${action} must remain available to unverified accounts`
        )
    }
  }
  if (
    choices.policy.unverifiedActions.some(
      (action) => !['logout', 'verificationResend', 'passwordReset'].includes(action)
    )
  )
    diagnostic(diagnostics, 'policy.unverifiedActions', 'Unsupported limited action')
  const emailEnabled = hasEmailFlow(choices)
  if (emailEnabled && !['adonisjs-mail', 'custom'].includes(choices.mail.integration))
    diagnostic(diagnostics, 'mail.integration', 'Choose adonisjs-mail or custom')
  if (emailEnabled && !['best-effort', 'durable'].includes(choices.mail.delivery))
    diagnostic(diagnostics, 'mail.delivery', 'Choose best-effort or durable')
  for (const field of ['senderEnv', 'transportEnv'] as const) {
    const name = choices.mail[field]
    if (emailEnabled && name && !envName.test(name))
      diagnostic(
        diagnostics,
        `mail.${field}`,
        'Use an uppercase environment variable name, not a secret'
      )
  }
  if (
    emailEnabled &&
    choices.mail.integration === 'adonisjs-mail' &&
    !state.files['config/mail.ts']
  )
    diagnostic(
      diagnostics,
      'config/mail.ts',
      'Configure AdonisJS Mail with a real transport before applying'
    )
  if (
    emailEnabled &&
    choices.mail.integration === 'custom' &&
    !state.files['app/services/account_kit_notifications.ts']
  )
    diagnostic(
      diagnostics,
      'mail.integration',
      'Provide #services/account_kit_notifications before activation'
    )
  else if (emailEnabled && choices.mail.integration === 'custom')
    diagnostic(
      diagnostics,
      'mail.callbacks',
      'Verify the application-owned notification callbacks for every selected email flow and a real delivery transport',
      'action'
    )
  if (emailEnabled && (!choices.mail.appName.trim() || /[\r\n]/.test(choices.mail.appName)))
    diagnostic(diagnostics, 'mail.appName', 'Application identity is required')
  if (emailEnabled && choices.mail.integration === 'adonisjs-mail' && !choices.mail.senderEnv)
    diagnostic(diagnostics, 'mail.senderEnv', 'Sender environment reference is required')
  if (emailEnabled && choices.mail.integration === 'adonisjs-mail' && !choices.mail.transportEnv)
    diagnostic(diagnostics, 'mail.transportEnv', 'Transport environment reference is required')
  if (emailEnabled && choices.mail.integration === 'adonisjs-mail') {
    for (const field of ['senderEnv', 'transportEnv'] as const) {
      const name = choices.mail[field]
      if (!name || !envName.test(name)) continue
      const value = process.env[name]
      if (value === undefined || value === '')
        diagnostic(
          diagnostics,
          `mail.${field}`,
          `${name} must be set before readiness can pass`,
          'action'
        )
      else if (!value.trim() || (field === 'senderEnv' && /[\r\n]/.test(value)))
        diagnostic(diagnostics, `mail.${field}`, 'Configured value must be nonblank and safe')
    }
  }
  for (const [feature, destination] of Object.entries(emailDestinations)) {
    if (
      emailEnabled &&
      choices.features.includes(feature as SetupFeature) &&
      !choices.mail.destinations[destination!]
    )
      diagnostic(
        diagnostics,
        `mail.destinations.${destination}`,
        'Enabled email flow needs a relative frontend destination'
      )
  }
  for (const [field, destination] of Object.entries(
    emailEnabled ? choices.mail.destinations : {}
  )) {
    if (destination === undefined) continue
    try {
      createActionUrls({
        backendOrigin: 'https://setup.invalid',
        appFrontendUrl: 'https://setup.invalid/app/',
        environment: 'test',
        destinations: { [field]: destination },
      })
    } catch {
      diagnostic(
        diagnostics,
        `mail.destinations.${field}`,
        'Use a safe relative frontend path without whitespace, traversal, query or fragment'
      )
    }
  }
  if (emailEnabled) {
    validateOrigin(diagnostics, 'mail.backendOriginEnv', choices.mail.backendOriginEnv, production)
    validateOrigin(
      diagnostics,
      'mail.frontendOriginEnv',
      choices.mail.frontendOriginEnv,
      production
    )
  }
  if (emailEnabled && choices.mail.delivery === 'durable' && !choices.mail.durableWorkerVerified)
    diagnostic(
      diagnostics,
      'mail.durableWorkerVerified',
      'Verify application-owned queue/outbox worker and retry before durable readiness'
    )
  if (emailEnabled && choices.mail.delivery === 'durable' && choices.mail.integration !== 'custom')
    diagnostic(
      diagnostics,
      'mail.delivery',
      'Durable delivery requires application-owned notification callbacks backed by a verified queue or outbox'
    )
  if (choices.social.status === 'approved-pending') {
    if (
      !choices.social.providers.length ||
      choices.social.providers.some((provider) => !['google', 'github'].includes(provider)) ||
      new Set(choices.social.providers).size !== choices.social.providers.length
    )
      diagnostic(diagnostics, 'social.providers', 'Select unique Google and/or GitHub providers')
    diagnostic(
      diagnostics,
      'social',
      'Social identity is approved but is not installed by this setup yet',
      'action'
    )
  }
  if (state.existingChoices?.authentication && !choices.authentication) {
    if (!retirementImpact)
      diagnostic(
        diagnostics,
        'authentication.retirement',
        'Read-only retirement impact count is unavailable; verify Account Kit provider, configuration and database access, then retry'
      )
    else if (retirementImpact.affectedAccounts > 0)
      diagnostic(
        diagnostics,
        'authentication.retirement',
        `${retirementImpact.affectedAccounts} of ${retirementImpact.inspectedAccounts} accounts would lose their last usable login; complete an owner-managed credential migration before retrying`
      )
    else if (!retirementMaintenanceWindow)
      diagnostic(
        diagnostics,
        'authentication.retirement',
        'Zero affected accounts were found, but retirement requires --retirement-maintenance-window to prevent concurrent credential changes'
      )
  }
  if (state.existingPrefix && state.existingPrefix !== choices.routePrefix)
    diagnostic(
      diagnostics,
      'routePrefix',
      'Changing the managed prefix needs an explicit route transition; review clients before reconfiguration',
      'action'
    )
  return diagnostics
}

function generatedEnv(choices: SetupChoices): string {
  const names = new Set<string>()
  if (hasEmailFlow(choices)) {
    names.add(choices.mail.backendOriginEnv)
    names.add(choices.mail.frontendOriginEnv)
    if (choices.mail.senderEnv) names.add(choices.mail.senderEnv)
    if (choices.mail.transportEnv) names.add(choices.mail.transportEnv)
  }
  return [
    '# Account Kit deployment values; supply real values through your deployment environment',
    ...[...names].sort().map((name) => `${name}=`),
    '',
  ].join('\n')
}

async function migrationContent(name: string, choices: SetupChoices): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url))
  let stub: string | undefined
  for (let depth = 0; depth < 3; depth++) {
    try {
      stub = await readFile(join(directory, 'stubs/migrations', `${name}.stub`), 'utf8')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    directory = dirname(directory)
  }
  if (stub === undefined) throw new Error(`Account Kit migration template ${name} is missing`)
  const schema = migrationSchema(choices.user.table, choices.user.idType)
  return stub
    .replace(/^\{\{\{ exports\([^\n]+\n\n/, '')
    .replaceAll('{{{ migration.usersTable }}}', schema.usersTable)
    .replaceAll('{{{ migration.userIdColumn }}}', schema.userIdColumn)
    .replaceAll('{{{ migration.tokenableIdColumn }}}', schema.tokenableIdColumn)
    .replaceAll('{{{ migration.inviterIdColumn }}}', schema.inviterIdColumn)
}

function addChange(
  changes: SetupFileChange[],
  state: SetupInspection,
  path: string,
  content: string,
  reason: string
) {
  const existing = state.files[path]
  changes.push({
    path,
    action: existing === undefined ? 'create' : existing === content ? 'unchanged' : 'conflict',
    content,
    reason,
  })
}

function ownedChange(
  changes: SetupFileChange[],
  state: SetupInspection,
  path: string,
  content: string,
  oldGenerated: string | null,
  reason: string
) {
  const existing = state.files[path]
  changes.push({
    path,
    action:
      existing === undefined
        ? 'create'
        : existing === content
          ? 'unchanged'
          : oldGenerated !== null && existing === oldGenerated
            ? 'update'
            : 'conflict',
    expected: existing,
    content,
    reason,
  })
}

function changedFields(before: unknown, after: unknown, path = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (
    !before ||
    !after ||
    typeof before !== 'object' ||
    typeof after !== 'object' ||
    Array.isArray(before) ||
    Array.isArray(after)
  )
    return [path]
  const oldRecord = before as Record<string, unknown>
  const newRecord = after as Record<string, unknown>
  return [...new Set([...Object.keys(oldRecord), ...Object.keys(newRecord)])].flatMap((key) =>
    changedFields(oldRecord[key], newRecord[key], path ? `${path}.${key}` : key)
  )
}

function managedRoutesSource(choices: SetupChoices): string {
  return [
    "import router from '@adonisjs/core/services/router'",
    "import app from '@adonisjs/core/services/app'",
    "import { AccountKit } from 'adonisjs-account-kit'",
    "import { registerManagedRoutes } from 'adonisjs-account-kit/http'",
    "import { accountKitGuard } from '#services/account_kit_guard'",
    '',
    'registerManagedRoutes(router, {',
    `  prefix: ${JSON.stringify(choices.routePrefix)},`,
    `  enabled: ${JSON.stringify(choices.managed)},`,
    ...('managedExcept' in choices
      ? [`  except: ${JSON.stringify(choices.managedExcept ?? [])},`]
      : []),
    `  verificationRequired: ${choices.policy.verificationRequired},`,
    '  kit: () => app.container.make(AccountKit),',
    '  guard: accountKitGuard,',
    '})',
    '',
  ].join('\n')
}

function disabledManagedRoutesSource(previous: SetupChoices): string {
  return `// Account Kit managed endpoints are disabled by setup.\n// Previous generated selection: ${Buffer.from(JSON.stringify(previous)).toString('base64url')}\n`
}

function retainedGeneratedChoices(state: SetupInspection): SetupChoices | null {
  const marker = state.files['start/account_kit_routes.ts']
  const encoded = marker?.match(
    /^\/\/ Account Kit managed endpoints are disabled by setup\.\n\/\/ Previous generated selection: ([A-Za-z0-9_-]+)\n$/
  )?.[1]
  if (!encoded) return null
  try {
    const previous = parseSetupChoices(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    )
    return marker === disabledManagedRoutesSource(previous) ? previous : null
  } catch {
    return null
  }
}

function managedGuardSource(choices: SetupChoices): string {
  const auth = choices.authentication!
  return [
    "import { createManagedGuard } from 'adonisjs-account-kit/http'",
    '',
    'export const accountKitGuard = createManagedGuard({',
    `  strategy: ${JSON.stringify(auth.strategy)},`,
    `  name: ${JSON.stringify(auth.guard)},`,
    `  loadUser: () => import(${JSON.stringify(choices.user.model)}).then((module) => module.default),`,
    '})',
    '',
  ].join('\n')
}

function managedAccessMiddlewareSource(choices: SetupChoices): string {
  return [
    "import app from '@adonisjs/core/services/app'",
    "import { AccountKit } from 'adonisjs-account-kit'",
    "import { managedAccountMiddleware } from 'adonisjs-account-kit/http'",
    "import { accountKitGuard } from '#services/account_kit_guard'",
    '',
    'export default managedAccountMiddleware({',
    '  kit: () => app.container.make(AccountKit),',
    '  guard: accountKitGuard,',
    `  active: ${choices.policy.verificationRequired},`,
    '})',
    '',
  ].join('\n')
}

function proofHeadersMiddlewareSource(choices: SetupChoices): string {
  return [
    "import type { HttpContext } from '@adonisjs/core/http'",
    "import { managedProofHeadersMiddleware } from 'adonisjs-account-kit/http'",
    '',
    'const applyProofHeaders = managedProofHeadersMiddleware({',
    `  prefix: ${JSON.stringify(choices.routePrefix)},`,
    `  enabled: ${JSON.stringify(choices.managed)},`,
    `  except: ${JSON.stringify(choices.managedExcept ?? [])},`,
    '})',
    '',
    'export default class AccountKitProofHeadersMiddleware {',
    '  handle(ctx: HttpContext, next: () => Promise<unknown>): Promise<unknown> {',
    '    return applyProofHeaders(ctx, next)',
    '  }',
    '}',
    '',
  ].join('\n')
}

function accountConfigSource(choices: SetupChoices): string {
  const emailEnabled = hasEmailFlow(choices)
  const managedMail = emailEnabled && choices.mail.integration === 'adonisjs-mail'
  const serviceCapabilities = choices.features.filter((name) => name !== 'authentication')
  const usesPolicy =
    choices.policy.accessRestrictionHook || choices.features.includes('invitations')
  const imports = [
    "import env from '#start/env'",
    ...(emailEnabled ? ["import app from '@adonisjs/core/services/app'"] : []),
    ...(managedMail ? ["import mail from '@adonisjs/mail/services/main'"] : []),
    `import { ${[
      ...(emailEnabled ? ['createActionUrls'] : []),
      'defineConfig',
      ...(choices.user.adapter === 'lucid' ? ['createLucidAdapter'] : []),
      ...(managedMail ? ['createMailNotifications'] : []),
    ].join(', ')} } from 'adonisjs-account-kit'`,
    ...(choices.user.adapter === 'custom'
      ? ["import users from '#services/account_kit_users'"]
      : []),
    ...(!emailEnabled || managedMail
      ? []
      : ["import { accountKitNotifications } from '#services/account_kit_notifications'"]),
    ...(usesPolicy ? ["import { accountKitPolicy } from '#services/account_kit_policy'"] : []),
    ...(choices.policy.registrationFields.length
      ? ["import { InvalidInputError } from 'adonisjs-account-kit/errors'"]
      : []),
    '',
    ...(emailEnabled
      ? [
          'const requiredEnv = (name: string): string => {',
          '  const value = process.env[name]',
          '  if (!value) throw new Error(`account_kit: ${name} must be configured`)',
          '  return value',
          '}',
        ]
      : []),
    ...(choices.policy.registrationFields.length
      ? [
          '',
          `const registrationFields: ReadonlyArray<{ name: string; type: 'string' | 'number' | 'boolean'; required: boolean; maxLength?: number }> = ${JSON.stringify(choices.policy.registrationFields)}`,
          'const mapRegistrationFields = (input: unknown): Record<string, unknown> => {',
          "  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new InvalidInputError('account_kit: registrationData must be an object')",
          '  const source = (input ?? {}) as Record<string, unknown>',
          '  const output: Record<string, unknown> = {}',
          '  for (const key of Object.keys(source)) if (!registrationFields.some((field) => field.name === key)) throw new InvalidInputError(`account_kit: registrationData.${key} is not allowed`)',
          '  for (const field of registrationFields) {',
          '    const value = Object.prototype.hasOwnProperty.call(source, field.name) ? source[field.name] : undefined',
          '    if (value === undefined) {',
          '      if (field.required) throw new InvalidInputError(`account_kit: registrationData.${field.name} is required`)',
          '      continue',
          '    }',
          '    if (typeof value !== field.type) throw new InvalidInputError(`account_kit: registrationData.${field.name} must be ${field.type}`)',
          "    if (field.type === 'string' && typeof value === 'string' && field.maxLength !== undefined && value.length > field.maxLength) throw new InvalidInputError(`account_kit: registrationData.${field.name} is too long`)",
          '    output[field.name] = value',
          '  }',
          '  return output',
          '}',
        ]
      : []),
    ...(choices.user.adapter === 'lucid'
      ? choices.policy.registrationFields.length
        ? [
            `const users = createLucidAdapter(async () => (await import(${JSON.stringify(choices.user.model)})).default, {`,
            '  mapRegistrationData: (data, user) => {',
            '    const fields = mapRegistrationFields(data)',
            '    for (const field of registrationFields) {',
            '      if (Object.prototype.hasOwnProperty.call(fields, field.name)) (user as unknown as Record<string, unknown>)[field.name] = fields[field.name]',
            '    }',
            '  },',
            '})',
          ]
        : [
            `const users = createLucidAdapter(async () => (await import(${JSON.stringify(choices.user.model)})).default)`,
          ]
      : []),
    '',
    'export default defineConfig({',
    '  users,',
    ...(choices.user.adapter === 'custom'
      ? [`  usersTable: ${JSON.stringify(choices.user.table)},`]
      : []),
    `  enabled: ${JSON.stringify(serviceCapabilities)},`,
    `  registration: { availability: ${JSON.stringify(choices.policy.registration)}${choices.policy.registrationFields.length ? ', mapFields: mapRegistrationFields' : ''} },`,
    `  passwordPolicy: ${JSON.stringify(choices.policy.password)},`,
    ...(emailEnabled ? [`  delivery: ${JSON.stringify(choices.mail.delivery)},`] : []),
    "  limiterSecret: env.get('APP_KEY').release(),",
    ...(choices.authentication
      ? [
          '  authentication: {',
          `    strategy: ${JSON.stringify(choices.authentication.strategy)},`,
          `    guard: ${JSON.stringify(choices.authentication.guard)},`,
          ...(choices.authentication.strategy === 'access_tokens' && choices.authentication.token
            ? [
                `    tokenExpiresIn: ${JSON.stringify(choices.authentication.token.lifetime)},`,
                `    tokenAbilities: ${JSON.stringify(choices.authentication.token.abilities)},`,
              ]
            : []),
          ...(choices.policy.accessRestrictionHook
            ? ['    canAccess: accountKitPolicy.canAccess,']
            : []),
          '  },',
        ]
      : []),
    ...(emailEnabled
      ? [
          '  urls: createActionUrls({',
          `    backendOrigin: requiredEnv(${JSON.stringify(choices.mail.backendOriginEnv)}),`,
          `    appFrontendUrl: requiredEnv(${JSON.stringify(choices.mail.frontendOriginEnv)}),`,
          "    environment: app.inProduction ? 'production' : app.inTest ? 'test' : 'development',",
          `    destinations: ${JSON.stringify(choices.mail.destinations)},`,
          '  }),',
        ]
      : ['  urls: {},']),
    ...(!emailEnabled
      ? ['  notify: {},']
      : managedMail
        ? [
            '  notify: createMailNotifications({',
            '    mail,',
            `    from: requiredEnv(${JSON.stringify(choices.mail.senderEnv)}),`,
            `    brandName: ${JSON.stringify(choices.mail.appName)},`,
            '  }),',
          ]
        : ['  notify: accountKitNotifications,']),
    ...(choices.features.includes('invitations')
      ? [
          '  authorize: accountKitPolicy.authorize,',
          '  onInvitationAccepted: accountKitPolicy.onInvitationAccepted,',
        ]
      : []),
    '})',
    '',
  ]
  return imports.join('\n')
}

async function planRouteImport(
  changes: SetupFileChange[],
  state: SetupInspection,
  diagnostics: SetupDiagnostic[]
) {
  const path = 'start/routes.ts'
  const previous = state.files[path]
  if (previous === undefined) {
    diagnostic(
      diagnostics,
      path,
      'Application route file is missing; create it before managed setup'
    )
    return
  }
  let source: SetupSource
  try {
    source = await parseSetupSource(previous)
  } catch {
    diagnostic(diagnostics, path, 'Application route source must be valid TypeScript before setup')
    return
  }
  let directMount = false
  const mountImports = source.file.statements
    .filter(source.ts.isImportDeclaration)
    .filter(
      (node) =>
        source.ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === 'adonisjs-account-kit/http' &&
        !node.importClause?.isTypeOnly
    )
  const namedMounts = mountImports.flatMap((node) => {
    const bindings = node.importClause?.namedBindings
    return bindings && source.ts.isNamedImports(bindings)
      ? bindings.elements.filter(
          (element) =>
            !element.isTypeOnly &&
            (element.propertyName?.text ?? element.name.text) === 'registerManagedRoutes'
        )
      : []
  })
  const namespaceMounts = mountImports.flatMap((node) => {
    const bindings = node.importClause?.namedBindings
    return bindings && source.ts.isNamespaceImport(bindings) ? [bindings.name.text] : []
  })
  const mountBinding = importedName(source, 'adonisjs-account-kit/http', 'registerManagedRoutes')
  let unsupportedMount =
    namedMounts.length > 1 ||
    namespaceMounts.some((name) => hasUnsafeBindingReferences(source, name, () => false))
  walk(source, (node) => {
    if (mountBinding && source.ts.isIdentifier(node) && node.text === mountBinding) {
      const parent = node.parent
      const declaration = source.ts.isImportSpecifier(parent) && parent.name === node
      const call = source.ts.isCallExpression(parent) && parent.expression === node
      const propertyName = source.ts.isPropertyAccessExpression(parent) && parent.name === node
      if (!declaration && !call && !propertyName) unsupportedMount = true
    }
    if (
      source.ts.isCallExpression(node) &&
      source.ts.isIdentifier(node.expression) &&
      node.expression.text === mountBinding
    )
      directMount = true
    if (
      source.ts.isCallExpression(node) &&
      source.ts.isIdentifier(node.expression) &&
      node.expression.text === 'registerManagedRoutes' &&
      !mountBinding
    )
      unsupportedMount = true
    if (
      source.ts.isCallExpression(node) &&
      source.ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'registerManagedRoutes'
    )
      unsupportedMount = true
  })
  if (directMount || unsupportedMount) {
    diagnostic(
      diagnostics,
      path,
      'Existing direct managed route mount must be reconciled before setup adds another'
    )
    return
  }
  const imports = source.file.statements
    .filter(source.ts.isImportDeclaration)
    .filter((node) => source.ts.isStringLiteral(node.moduleSpecifier))
    .filter(
      (node) =>
        !node.importClause?.isTypeOnly &&
        (!node.importClause?.namedBindings ||
          !source.ts.isNamedImports(node.importClause.namedBindings) ||
          node.importClause.namedBindings.elements.some((element) => !element.isTypeOnly))
    )
    .map((node) => (node.moduleSpecifier as TypeScript.StringLiteral).text)
  if (imports.includes('./account_kit_routes.js')) {
    changes.push({
      path,
      action: 'unchanged',
      content: previous,
      reason: 'Managed route mount is already active',
    })
    return
  }
  if (imports.some((name) => name.includes('account_kit_routes'))) {
    diagnostic(diagnostics, path, 'Existing Account Kit route import differs; resolve it manually')
    return
  }
  changes.push({
    path,
    action: 'update',
    expected: previous,
    content: `${previous.trimEnd()}\n\nimport './account_kit_routes.js'\n`,
    reason: 'Explicitly mount the package-maintained endpoints',
  })
}

function lazyImportPath(source: SetupSource, node: TypeScript.Node): string | null {
  const { ts } = source
  if (!ts.isArrowFunction(node) || !ts.isCallExpression(node.body)) return null
  const call = node.body
  if (
    call.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    call.arguments.length !== 1 ||
    !ts.isStringLiteral(call.arguments[0])
  )
    return null
  return call.arguments[0].text
}

function callArray(
  source: SetupSource,
  receiver: string,
  method: string
): TypeScript.ArrayLiteralExpression | null {
  const matches: TypeScript.ArrayLiteralExpression[] = []
  walk(source, (node) => {
    if (
      exactCall(source, node, receiver, method) &&
      source.ts.isExpressionStatement(node.parent) &&
      node.parent.parent === source.file &&
      node.arguments.length === 1 &&
      source.ts.isArrayLiteralExpression(node.arguments[0])
    )
      matches.push(node.arguments[0])
  })
  return matches.length === 1 ? matches[0] : null
}

async function planArrayImports(
  changes: SetupFileChange[],
  state: SetupInspection,
  diagnostics: SetupDiagnostic[],
  path: string,
  _marker: string,
  imports: string[]
) {
  const previous = state.files[path]
  let source: SetupSource | null = null
  try {
    if (previous !== undefined) source = await parseSetupSource(previous)
  } catch {
    /* the diagnostic below identifies the supported shape */
  }
  const target = source && defaultExpression(source)
  let object: TypeScript.ObjectLiteralExpression | null = null
  if (source && target) {
    if (source.ts.isObjectLiteralExpression(target.expression)) object = target.expression
    else if (
      source.ts.isCallExpression(target.expression) &&
      source.ts.isIdentifier(target.expression.expression) &&
      target.expression.expression.text ===
        importedName(source, '@adonisjs/core/app', 'defineConfig') &&
      target.expression.arguments.length === 1 &&
      source.ts.isObjectLiteralExpression(target.expression.arguments[0])
    )
      object = target.expression.arguments[0]
  }
  const providers = source && object && directProperty(source, object, 'providers')
  if (
    !previous ||
    !source ||
    !providers ||
    !source.ts.isArrayLiteralExpression(providers.initializer)
  ) {
    diagnostic(
      diagnostics,
      path,
      `Expected a default-exported providers array in ${path}; configure these imports manually before activation`
    )
    return
  }
  const array = providers.initializer
  const present = new Set(
    array.elements.map((entry) => lazyImportPath(source!, entry)).filter(Boolean)
  )
  const missing = imports.filter((name) => !present.has(name))
  if (!missing.length) {
    changes.push({
      path,
      action: 'unchanged',
      content: previous,
      reason: 'Required imports are already present',
    })
    return
  }
  const at = array.getStart(source.file) + 1
  changes.push({
    path,
    action: 'update',
    expected: previous,
    content:
      previous.slice(0, at) +
      `\n${missing.map((name) => `    () => import('${name}'),`).join('\n')}` +
      previous.slice(at),
    reason: 'Register required framework providers or middleware',
  })
}

function insertAfterArrayElement(
  source: SetupSource,
  array: TypeScript.ArrayLiteralExpression,
  index: number,
  importPath: string
): string {
  const element = array.elements[index]
  const next = array.elements[index + 1]
  const limit = next ? next.getStart(source.file) : array.getEnd() - 1
  const between = source.text.slice(element.getEnd(), limit)
  const executable = stripSourceComments(between)
  const comma = executable.indexOf(',')
  const withComma =
    comma < 0
      ? source.text.slice(0, element.getEnd()) + ',' + source.text.slice(element.getEnd())
      : source.text
  const afterExpression = element.getEnd() + (comma < 0 ? 1 : comma + 1)
  const lineComment = between.indexOf('//')
  const newline = between.indexOf('\n', lineComment < 0 ? 0 : lineComment)
  const at =
    lineComment >= 0 && newline >= 0
      ? element.getEnd() + newline + 1 + (comma < 0 ? 1 : 0)
      : afterExpression
  const entry = `  () => import('${importPath}'),`
  const insertion = at === afterExpression ? `\n${entry}` : `${entry}\n`
  return withComma.slice(0, at) + insertion + withComma.slice(at)
}

async function planRouterMiddleware(
  changes: SetupFileChange[],
  state: SetupInspection,
  diagnostics: SetupDiagnostic[],
  session: boolean
) {
  const path = 'start/kernel.ts'
  const previous = state.files[path]
  if (!previous) {
    diagnostic(diagnostics, path, 'Expected one conventional router.use array in start/kernel.ts')
    return
  }
  let content = previous
  let source: SetupSource
  try {
    source = await parseSetupSource(content)
  } catch {
    diagnostic(diagnostics, path, 'Router middleware source must be valid TypeScript before setup')
    return
  }
  let array = callArray(source, 'router', 'use')
  const server = callArray(source, 'server', 'use')
  if (
    !array ||
    !server ||
    defaultImportName(source, '@adonisjs/core/services/router') !== 'router' ||
    defaultImportName(source, '@adonisjs/core/services/server') !== 'server'
  ) {
    diagnostic(
      diagnostics,
      path,
      'Expected one conventional server.use and router.use array in start/kernel.ts'
    )
    return
  }
  const body = '@adonisjs/core/bodyparser_middleware'
  const ordered = [
    body,
    ...(session
      ? ['@adonisjs/session/session_middleware', '@adonisjs/shield/shield_middleware']
      : []),
    '@adonisjs/auth/initialize_auth_middleware',
  ]
  if (
    server.elements.some((entry) => ordered.slice(1).includes(lazyImportPath(source, entry) ?? ''))
  ) {
    diagnostic(
      diagnostics,
      path,
      'Account middleware already appears in server.use; move it to the ordered router.use stack manually'
    )
    return
  }
  const paths = array.elements.map((entry) => lazyImportPath(source, entry))
  if (
    paths.some((name) => name === null) ||
    paths.filter((name) => name === body).length !== 1 ||
    ordered.some((name) => paths.filter((entry) => entry === name).length > 1)
  ) {
    diagnostic(
      diagnostics,
      path,
      'Router middleware layout is ambiguous; preserve body parser, session, Shield, then auth order manually'
    )
    return
  }
  const existing = ordered.map((name) => paths.indexOf(name)).filter((index) => index >= 0)
  if (existing.some((index, position) => position > 0 && index <= existing[position - 1])) {
    diagnostic(
      diagnostics,
      path,
      'Existing router middleware order is unsafe; require body parser, session, Shield, then auth'
    )
    return
  }
  for (let position = 1; position < ordered.length; position++) {
    const currentPaths = array.elements.map((entry) => lazyImportPath(source, entry))
    if (currentPaths.includes(ordered[position])) continue
    const preceding = currentPaths.indexOf(ordered[position - 1])
    if (preceding < 0) throw new Error('Missing previously planned router middleware')
    content = insertAfterArrayElement(source, array, preceding, ordered[position])
    try {
      source = await parseSetupSource(content)
    } catch {
      diagnostic(
        diagnostics,
        path,
        'Router middleware layout cannot be changed safely; use a complete import expression before setup'
      )
      return
    }
    array = callArray(source, 'router', 'use')
    if (!array) {
      diagnostic(
        diagnostics,
        path,
        'Router middleware layout cannot be changed safely; use a conventional array before setup'
      )
      return
    }
  }
  changes.push({
    path,
    action: content === previous ? 'unchanged' : 'update',
    expected: previous,
    content,
    reason: 'Keep account middleware after body parsing on registered routes',
  })
}

async function planServerProofMiddleware(
  changes: SetupFileChange[],
  state: SetupInspection,
  diagnostics: SetupDiagnostic[]
) {
  const path = 'start/kernel.ts'
  const existing = changes.find((change) => change.path === path)
  const previous = existing?.content ?? state.files[path]
  let source: SetupSource | null = null
  try {
    if (previous) source = await parseSetupSource(previous)
  } catch {
    /* report supported shape below */
  }
  const array = source && callArray(source, 'server', 'use')
  if (
    !previous ||
    !source ||
    !array ||
    defaultImportName(source, '@adonisjs/core/services/server') !== 'server'
  ) {
    diagnostic(
      diagnostics,
      path,
      'Expected one conventional server.use array before router middleware'
    )
    return
  }
  const name = '#middleware/account_kit_proof_headers_middleware'
  const proofPosition = array.elements.findIndex((entry) => lazyImportPath(source, entry) === name)
  if (proofPosition === 0) return
  if (proofPosition > 0) {
    diagnostic(
      diagnostics,
      path,
      'Move proof response headers to the first server.use position, before body parsing or terminating middleware'
    )
    return
  }
  const at = array.getStart(source.file) + 1
  const content = previous.slice(0, at) + `\n  () => import('${name}'),` + previous.slice(at)
  if (existing) {
    existing.content = content
    existing.action = existing.action === 'unchanged' ? 'update' : existing.action
    existing.reason += '; install early proof response headers'
  } else
    changes.push({
      path,
      action: 'update',
      expected: state.files[path],
      content,
      reason: 'Install early proof response headers before body parsing and Shield',
    })
}

async function shieldCsrfState(text: string): Promise<'true' | 'false' | 'dynamic' | 'missing'> {
  let source: SetupSource
  try {
    source = await parseSetupSource(text)
  } catch {
    return 'missing'
  }
  const shieldFactory = importedName(source, '@adonisjs/shield', 'defineConfig')
  const target = defaultExpression(source)
  const expression = target?.expression
  const object =
    expression && source.ts.isObjectLiteralExpression(expression)
      ? expression
      : shieldFactory &&
          expression &&
          source.ts.isCallExpression(expression) &&
          source.ts.isIdentifier(expression.expression) &&
          expression.expression.text === shieldFactory &&
          expression.arguments.length === 1 &&
          source.ts.isObjectLiteralExpression(expression.arguments[0])
        ? expression.arguments[0]
        : null
  const csrf = object && directProperty(source, object, 'csrf')
  if (!csrf || !source.ts.isObjectLiteralExpression(csrf.initializer)) return 'missing'
  const enabled = directProperty(source, csrf.initializer, 'enabled')
  if (!enabled) return 'missing'
  if (enabled.initializer.kind === source.ts.SyntaxKind.TrueKeyword) return 'true'
  if (enabled.initializer.kind === source.ts.SyntaxKind.FalseKeyword) return 'false'
  return 'dynamic'
}

async function mailerSelectionState(
  text: string,
  root: string,
  transportEnv: string | null
): Promise<'missing' | 'invalid' | 'unresolved' | 'present'> {
  let source: SetupSource
  try {
    source = await parseSetupSource(text)
  } catch {
    return 'unresolved'
  }
  const { ts } = source
  const target = defaultExpression(source)?.expression
  const factory = importedName(source, '@adonisjs/mail', 'defineConfig')
  const object =
    target && ts.isObjectLiteralExpression(target)
      ? target
      : factory &&
          target &&
          ts.isCallExpression(target) &&
          ts.isIdentifier(target.expression) &&
          target.expression.text === factory &&
          target.arguments.length === 1 &&
          ts.isObjectLiteralExpression(target.arguments[0])
        ? target.arguments[0]
        : null
  if (!object || hasUnsafeObjectEntries(source, object)) return 'unresolved'
  const mailers = directProperty(source, object, 'mailers')?.initializer
  if (!mailers || !ts.isObjectLiteralExpression(mailers) || hasUnsafeObjectEntries(source, mailers))
    return 'unresolved'
  if (mailers.properties.length === 0) return 'missing'
  const selector = directProperty(source, object, 'default')?.initializer
  let selected: string | null = null
  if (selector && ts.isStringLiteral(selector)) selected = selector.text
  else if (selector && transportEnv) {
    const env = defaultImportName(source, '#start/env')
    if (!env || !safeEnvGetter(source, env) || !exactCall(source, selector, env, 'get'))
      return 'unresolved'
    const args = selector.arguments
    if (
      args.length < 1 ||
      args.length > 2 ||
      !ts.isStringLiteral(args[0]) ||
      args[0].text !== transportEnv ||
      (args.length === 2 && !ts.isStringLiteral(args[1]))
    )
      return 'unresolved'
    try {
      selected =
        (await resolveSelectedEnvironment(root, transportEnv)) ??
        (args.length === 2 ? (args[1] as TypeScript.StringLiteral).text : null)
    } catch {
      return 'unresolved'
    }
  }
  if (!selected) return 'unresolved'
  const mailer = directProperty(source, mailers, selected)
  if (!mailer) return 'missing'
  let value: TypeScript.Expression = mailer.initializer
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value)
  )
    value = value.expression
  if (
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(value) ||
    (ts.isIdentifier(value) && value.text === 'undefined')
  )
    return 'invalid'
  return 'present'
}

async function limiterConfigurationState(
  text: string,
  root: string
): Promise<'valid' | 'invalid' | 'unresolved'> {
  let source: SetupSource
  try {
    source = await parseSetupSource(text)
  } catch {
    return 'invalid'
  }
  const defineConfigName = importedName(source, '@adonisjs/limiter', 'defineConfig')
  const storesName = importedName(source, '@adonisjs/limiter', 'stores')
  const config = defineConfigName && topLevelConfig(source, defineConfigName)?.object
  if (!config || !storesName || hasUnsafeObjectEntries(source, config)) return 'invalid'
  const selected = directProperty(source, config, 'default')?.initializer
  const stores = directProperty(source, config, 'stores')?.initializer
  if (!selected || !stores || !source.ts.isObjectLiteralExpression(stores)) return 'invalid'
  if (hasUnsafeObjectEntries(source, stores)) return 'invalid'
  let name: string | null = null
  if (source.ts.isStringLiteral(selected)) name = selected.text
  else {
    const env = defaultImportName(source, '#start/env')
    if (!env || !exactCall(source, selected, env, 'get') || !safeEnvGetter(source, env))
      return 'unresolved'
    const args = selected.arguments
    if (
      args.length < 1 ||
      args.length > 2 ||
      !source.ts.isStringLiteral(args[0]) ||
      !/^[A-Z][A-Z0-9_]*$/.test(args[0].text) ||
      (args.length === 2 && !source.ts.isStringLiteral(args[1]))
    )
      return 'unresolved'
    try {
      name =
        (await selectedSessionEnvironment(root, args[0].text)) ??
        (args.length === 2 ? (args[1] as TypeScript.StringLiteral).text : null)
    } catch {
      return 'unresolved'
    }
  }
  if (!name) return 'unresolved'
  const factory = directProperty(source, stores, name)?.initializer
  if (
    !factory ||
    !source.ts.isCallExpression(factory) ||
    !source.ts.isPropertyAccessExpression(factory.expression) ||
    !source.ts.isIdentifier(factory.expression.expression) ||
    factory.expression.expression.text !== storesName ||
    !['database', 'memory', 'redis'].includes(factory.expression.name.text)
  )
    return 'invalid'
  if (
    hasUnsafeBindingReferences(source, storesName, (call) => {
      if (!source.ts.isPropertyAccessExpression(call.expression)) return false
      return (
        ['database', 'memory', 'redis'].includes(call.expression.name.text) &&
        call.getStart(source.file) > stores.getStart(source.file) &&
        call.getEnd() < stores.getEnd()
      )
    })
  )
    return 'invalid'
  return 'valid'
}

const sessionImport =
  "// account-kit:session-import:start\nimport { protectManagedSessionConfig } from 'adonisjs-account-kit/http'\n// account-kit:session-import:end\n"
const selectionStart = '// account-kit:session-selection:start\n'
const selectionEnd = '\n// account-kit:session-selection:end\n'
const exportStart = '// account-kit:session-export:start\n'
const exportEnd = '// account-kit:session-export:end\n'

interface NativeSessionConfiguration {
  configStart: number
  exportStartIndex: number
  originalStore: string
  originalSelection: string
  storeStart: number
  allowedStores: Array<{ name: string; kind: 'database' | 'memory' }>
  selectedName: string | null
  selected: { name: string; kind: 'database' | 'memory' } | null
}

async function nativeSessionConfiguration(
  text: string,
  root: string
): Promise<NativeSessionConfiguration | null> {
  const source = await parseSetupSource(text)
  const { ts, file } = source
  const defineConfigName = importedName(source, '@adonisjs/session', 'defineConfig')
  const storesName = importedName(source, '@adonisjs/session', 'stores')
  if (!defineConfigName || !storesName) return null
  const target = topLevelConfig(source, defineConfigName)
  if (!target?.declaration || hasUnsafeObjectEntries(source, target.object)) return null
  const declaration = target.declaration
  if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'sessionConfig') return null
  if (!ts.isVariableStatement(declaration.parent.parent)) return null
  if (!(declaration.parent.flags & ts.NodeFlags.Const)) return null
  const store = directProperty(source, target.object, 'store')
  const stores = directProperty(source, target.object, 'stores')
  if (!store || !stores || !ts.isObjectLiteralExpression(stores.initializer)) return null
  if (hasUnsafeObjectEntries(source, stores.initializer)) return null
  const allowedStores: NativeSessionConfiguration['allowedStores'] = []
  for (const property of stores.initializer.properties) {
    if (!ts.isPropertyAssignment(property)) return null
    const name =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : null
    if (!name) return null
    for (const kind of ['database', 'memory'] as const) {
      if (exactCall(source, property.initializer, storesName, kind))
        allowedStores.push({ name, kind })
    }
  }
  let selectedName: string | null = null
  if (ts.isStringLiteral(store.initializer)) selectedName = store.initializer.text
  else {
    const envBinding = defaultImportName(source, '#start/env')
    if (
      !envBinding ||
      !exactCall(source, store.initializer, envBinding, 'get') ||
      !safeEnvGetter(source, envBinding)
    )
      return null
    const args = store.initializer.arguments
    if (
      args.length < 1 ||
      args.length > 2 ||
      !ts.isStringLiteral(args[0]) ||
      !/^[A-Z][A-Z0-9_]*$/.test(args[0].text) ||
      (args.length === 2 && !ts.isStringLiteral(args[1]))
    )
      return null
    selectedName =
      (await selectedSessionEnvironment(root, args[0].text)) ??
      (args.length === 2 ? (args[1] as TypeScript.StringLiteral).text : null)
  }
  let unsafe = false
  walk(source, (node) => {
    if (!ts.isIdentifier(node)) return
    if (node.text === storesName) {
      if (
        ts.isImportSpecifier(node.parent) ||
        (ts.isPropertyAssignment(node.parent) && node.parent.name === node)
      )
        return
      const property = node.parent
      const call = property.parent
      if (
        ts.isPropertyAccessExpression(property) &&
        property.expression === node &&
        ts.isCallExpression(call) &&
        call.expression === property &&
        call.getStart(file) > stores.initializer.getStart(file) &&
        call.getEnd() < stores.initializer.getEnd()
      )
        return
      unsafe = true
    }
    if (
      node.text === 'sessionConfig' &&
      node !== declaration.name &&
      node !== target.exportAssignment.expression
    )
      unsafe = true
  })
  if (unsafe) return null
  const selected = allowedStores.find(({ name }) => name === selectedName) ?? null
  return {
    configStart: declaration.parent.parent.getStart(file),
    exportStartIndex: target.exportAssignment.getStart(file),
    originalStore: store.initializer.getText(file),
    originalSelection: store.getText(file),
    storeStart: store.getStart(file),
    allowedStores,
    selectedName,
    selected,
  }
}

/** A diagnostic-only classifier; it never authorizes automatic attestation. */
async function selectedSessionDiagnostic(
  text: string,
  root: string
): Promise<{
  name: string | null
  kind: string | null
} | null> {
  const source = await parseSetupSource(text)
  const object = exportedObject(
    source,
    importedName(source, '@adonisjs/session', 'defineConfig') ?? undefined
  )
  const store = object && directProperty(source, object, 'store')
  const stores = object && directProperty(source, object, 'stores')
  if (!store || !stores || !source.ts.isObjectLiteralExpression(stores.initializer)) return null
  let name: string | null = null
  if (source.ts.isStringLiteral(store.initializer)) name = store.initializer.text
  else if (
    defaultImportName(source, '#start/env') &&
    safeEnvGetter(source, defaultImportName(source, '#start/env')!) &&
    exactCall(source, store.initializer, defaultImportName(source, '#start/env')!, 'get') &&
    store.initializer.arguments.length >= 1 &&
    source.ts.isStringLiteral(store.initializer.arguments[0])
  )
    name = await selectedSessionEnvironment(root, store.initializer.arguments[0].text)
  if (!name) return { name: null, kind: null }
  const selected = directProperty(source, stores.initializer, name)
  const initializer = selected?.initializer
  const kind =
    initializer &&
    source.ts.isCallExpression(initializer) &&
    source.ts.isPropertyAccessExpression(initializer.expression) &&
    source.ts.isIdentifier(initializer.expression.expression) &&
    initializer.expression.expression.text === 'stores'
      ? initializer.expression.name.text
      : null
  return { name, kind }
}

function renderManagedSessionConfig(source: string, inspected: NativeSessionConfiguration): string {
  const {
    configStart,
    exportStartIndex,
    originalStore,
    originalSelection,
    storeStart,
    allowedStores,
  } = inspected
  const selector = 'accountKitSelectedSessionStore'
  const selection = `${selectionStart}const ${selector} = ${originalStore}${selectionEnd}`
  const verify = allowedStores
    .map(({ name, kind }) =>
      kind === 'memory'
        ? `(${selector} === ${JSON.stringify(name)} && process.env.NODE_ENV !== 'production')`
        : `${selector} === ${JSON.stringify(name)}`
    )
    .join(' || ')
  const wrappedExport = `${exportStart}export default protectManagedSessionConfig(sessionConfig, {
  verifyStore: (actual) =>
    (${verify}) &&
    actual !== null &&
    typeof actual === 'object' &&
    ['read', 'write', 'destroy', 'touch'].every(
      (method) => typeof (actual as Record<string, unknown>)[method] === 'function'
    ),
})
${exportEnd}`
  return (
    sessionImport +
    source.slice(0, configStart) +
    selection +
    source.slice(configStart, storeStart) +
    `store: ${selector}` +
    source.slice(storeStart + originalSelection.length, exportStartIndex) +
    wrappedExport +
    source.slice(exportStartIndex + 'export default sessionConfig'.length)
  )
}

async function unwrapManagedSessionConfig(source: string, root: string): Promise<string | null> {
  if (!source.startsWith(sessionImport)) return null
  const selectionMatch = source.match(
    /\/\/ account-kit:session-selection:start\nconst accountKitSelectedSessionStore = ([\s\S]*?)\n\/\/ account-kit:session-selection:end\n/
  )
  const exportMatch = source.match(
    /\/\/ account-kit:session-export:start\n[\s\S]*?\/\/ account-kit:session-export:end\n/
  )
  if (!selectionMatch || !exportMatch) return null
  const base = source
    .slice(sessionImport.length)
    .replace(selectionMatch[0], '')
    .replace('store: accountKitSelectedSessionStore', `store: ${selectionMatch[1]}`)
    .replace(exportMatch[0], 'export default sessionConfig')
  const inspected = await nativeSessionConfiguration(base, root)
  return inspected && renderManagedSessionConfig(base, inspected) === source ? base : null
}

async function planSessionConfigIntegration(
  changes: SetupFileChange[],
  state: SetupInspection,
  choices: SetupChoices,
  diagnostics: SetupDiagnostic[]
): Promise<void> {
  const path = 'config/session.ts'
  const previous = state.files[path]
  if (!previous) return
  const wantsManagedSession =
    choices.managed.length > 0 && choices.authentication?.strategy === 'session'
  const wasManaged = previous.includes('account-kit:session-import:start')
  const base = wasManaged ? await unwrapManagedSessionConfig(previous, state.root) : previous
  if (base === null) {
    diagnostic(
      diagnostics,
      path,
      'The managed session integration was edited; restore its marked block or reconcile it manually before setup'
    )
    return
  }
  if (!wantsManagedSession && !wasManaged) return
  const parsed = await parseSetupSource(previous)
  const existingWrapper = defaultExpression(parsed)
  const wrapperBinding = importedName(
    parsed,
    'adonisjs-account-kit/http',
    'protectManagedSessionConfig'
  )
  if (
    !wasManaged &&
    wrapperBinding &&
    existingWrapper &&
    parsed.ts.isCallExpression(existingWrapper.expression) &&
    parsed.ts.isIdentifier(existingWrapper.expression.expression) &&
    existingWrapper.expression.expression.text === wrapperBinding
  ) {
    diagnostic(
      diagnostics,
      path,
      'Verify the existing application-owned session protection wrapper before enabling managed session routes',
      'action'
    )
    return
  }
  let inspected: NativeSessionConfiguration | null = null
  if (wantsManagedSession) {
    try {
      inspected = await nativeSessionConfiguration(base, state.root)
    } catch {
      diagnostic(
        diagnostics,
        path,
        'Inspect the selected session environment assignment and file path; only a direct native store name is supported'
      )
      return
    }
  }
  if (wantsManagedSession && !inspected?.selected) {
    diagnostic(
      diagnostics,
      path,
      'The selected session factory must be an inspected native database or development memory store; custom or unresolved selections need a truthful application-owned protectManagedSessionConfig wrapper'
    )
    return
  }
  const content =
    wantsManagedSession && inspected ? renderManagedSessionConfig(base, inspected) : base
  if (content === null) {
    diagnostic(
      diagnostics,
      path,
      'Use a conventional const sessionConfig = defineConfig(...) and export default sessionConfig, or wire protectManagedSessionConfig manually before managed session activation'
    )
    return
  }
  changes.push({
    path,
    action: previous === content ? 'unchanged' : 'update',
    expected: previous,
    content,
    reason: wantsManagedSession
      ? 'Verify the selected server-side session store before issuing managed credentials'
      : 'Retire the setup-owned managed session verification wrapper',
  })
}

/** Build the complete proposal before a write. Apply refuses every conflict in this plan. */
export async function planSetup(
  choices: SetupChoices,
  state: SetupInspection,
  options: {
    apply?: boolean
    production?: boolean
    timestamp?: number
    retirementImpact?: SetupPlan['retirementImpact']
    retirementMaintenanceWindow?: boolean
  } = {}
): Promise<SetupPlan> {
  choices = parseSetupChoices(choices)
  const diagnostics = validate(
    choices,
    state,
    options.production ?? false,
    options.retirementImpact ?? null,
    options.retirementMaintenanceWindow ?? false
  )
  if (
    hasEmailFlow(choices) &&
    choices.mail.integration === 'adonisjs-mail' &&
    state.files['config/mail.ts']
  ) {
    const selection = await mailerSelectionState(
      state.files['config/mail.ts'],
      state.root,
      choices.mail.transportEnv
    )
    if (selection === 'missing')
      diagnostic(
        diagnostics,
        'config/mail.ts',
        'Selected Mail mailer is absent from the configured mailers map'
      )
    else if (selection === 'invalid')
      diagnostic(
        diagnostics,
        'config/mail.ts',
        'Selected Mail mailer has a null or undefined transport'
      )
    else
      diagnostic(
        diagnostics,
        'config/mail.ts',
        selection === 'unresolved'
          ? 'Confirm the selected Mail mailer and its transport configuration manually before readiness'
          : 'Verify the selected Mail transport delivers messages with the deployed configuration before readiness',
        'action'
      )
  }
  if (
    choices.user.adapter === 'lucid' &&
    /^#models\/[A-Za-z_][A-Za-z0-9_/]*$/.test(choices.user.model) &&
    !choices.user.model.includes('//')
  ) {
    const modelPath = `app/models/${choices.user.model.slice('#models/'.length)}.ts`
    try {
      const modelFile = await safeSetupPath(state.root, modelPath)
      const modelStat = await lstat(modelFile)
      if (!modelStat.isFile())
        throw new Error(`Setup cannot inspect non-regular model ${modelPath}`)
      const model = await parseSetupSource(await readFile(modelFile, 'utf8'))
      const { ts } = model
      const classes = model.file.statements.filter(
        (node): node is TypeScript.ClassDeclaration =>
          ts.isClassDeclaration(node) &&
          Boolean(
            node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
          ) &&
          Boolean(
            node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
          )
      )
      const selectedClass = classes.length === 1 ? classes[0] : null
      const baseModelBinding = importedName(model, '@adonisjs/lucid/orm', 'BaseModel')
      if (
        !selectedClass ||
        !selectedClass.heritageClauses?.some(
          (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
        )
      )
        diagnostic(
          diagnostics,
          'user.model',
          'Selected Lucid model must expose a default model class'
        )
      const staticMember = (name: string) =>
        selectedClass?.members.filter(
          (member) =>
            ts.isPropertyDeclaration(member) &&
            Boolean(
              member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
            ) &&
            (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
            member.name.text === name
        ) ?? []
      const metadataNames = ['table', 'connection', 'accessTokens']
      const unsafeMetadata =
        selectedClass?.members.some((member) => {
          if (ts.isClassStaticBlockDeclaration(member)) return true
          if (
            !ts.canHaveModifiers(member) ||
            !ts
              .getModifiers(member)
              ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
          )
            return false
          const name = member.name
          if (!name) return false
          if (ts.isComputedPropertyName(name)) return true
          return (
            !ts.isPropertyDeclaration(member) &&
            (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
            metadataNames.includes(name.text)
          )
        }) || metadataNames.some((name) => staticMember(name).length > 1)
      let mutatedModel = false
      if (selectedClass?.name)
        walk(model, (node) => {
          if (
            ts.isIdentifier(node) &&
            node.text === selectedClass.name!.text &&
            node !== selectedClass.name
          )
            mutatedModel = true
        })
      if (unsafeMetadata || mutatedModel)
        diagnostic(
          diagnostics,
          'user.model',
          'Model static metadata or later class references require manual review before generated migrations'
        )
      if (
        choices.authentication?.strategy === 'access_tokens' &&
        staticMember('accessTokens').length !== 1
      )
        diagnostic(
          diagnostics,
          'user.model',
          'Token guard model must expose its existing static accessTokens provider'
        )
      const tableMember = staticMember('table')
      const tableInitializer =
        tableMember.length === 1 && ts.isPropertyDeclaration(tableMember[0])
          ? tableMember[0].initializer
          : undefined
      const table =
        tableInitializer && ts.isStringLiteral(tableInitializer) ? tableInitializer.text : null
      if (table && table !== choices.user.table)
        diagnostic(
          diagnostics,
          'user.table',
          `Model table ${table} differs from selected ${choices.user.table}`
        )
      if (staticMember('connection').length)
        diagnostic(
          diagnostics,
          'user.connection',
          'Selected Lucid model must not declare an explicit connection override'
        )
      if (!table)
        diagnostic(
          diagnostics,
          'user.table',
          'Verify the model table, including inherited or inferred mapping, matches the generated migrations',
          'action'
        )
      const extendsBase = selectedClass?.heritageClauses?.some(
        (clause) =>
          clause.token === ts.SyntaxKind.ExtendsKeyword &&
          clause.types.some(
            (item) =>
              (ts.isIdentifier(item.expression) && item.expression.text === baseModelBinding) ||
              (ts.isCallExpression(item.expression) &&
                ts.isIdentifier(item.expression.expression) &&
                item.expression.expression.text ===
                  importedName(model, '@adonisjs/core/helpers', 'compose') &&
                ts.isIdentifier(item.expression.arguments[0]) &&
                item.expression.arguments[0].text === baseModelBinding)
          )
      )
      if (!extendsBase)
        diagnostic(
          diagnostics,
          'user.connection',
          'Resolve the imported Lucid BaseModel inheritance before using this model for generated migrations'
        )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      diagnostic(diagnostics, 'user.model', `${modelPath} was not found`)
    }
  }
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
  if (
    !choices.authentication &&
    state.existingChoices?.authentication &&
    state.files['app/middleware/account_kit_access_middleware.ts']
  )
    diagnostic(
      diagnostics,
      'authentication.retirement',
      'Review application-owned routes for the generated account access middleware and remove or replace their references after authentication retirement',
      'action'
    )
  if (
    choices.authentication &&
    (choices.managed.length || state.files['app/services/account_kit_guard.ts'])
  ) {
    ownedChange(
      changes,
      state,
      'app/services/account_kit_guard.ts',
      managedGuardSource(choices),
      priorGenerated?.authentication ? managedGuardSource(priorGenerated) : null,
      'Adapt the selected existing AdonisJS guard'
    )
    ownedChange(
      changes,
      state,
      'app/middleware/account_kit_access_middleware.ts',
      managedAccessMiddlewareSource(choices),
      priorGenerated?.authentication ? managedAccessMiddlewareSource(priorGenerated) : null,
      'Offer the same account revision and restriction gate to application-owned routes'
    )
  }
  if (choices.managed.length && choices.authentication) {
    ownedChange(
      changes,
      state,
      'start/account_kit_routes.ts',
      managedRoutesSource(choices),
      state.existingChoices?.authentication && state.existingChoices.managed.length
        ? managedRoutesSource(state.existingChoices)
        : retainedChoices
          ? disabledManagedRoutesSource(retainedChoices)
          : null,
      'Mount selected maintained endpoints through the existing guard'
    )
  } else if (state.existingChoices?.managed.length && state.existingChoices.authentication) {
    ownedChange(
      changes,
      state,
      'start/account_kit_routes.ts',
      disabledManagedRoutesSource(state.existingChoices),
      managedRoutesSource(state.existingChoices),
      'Retire the managed route mount without changing application routes or account data'
    )
  }
  if (
    choices.managed.length ||
    state.files['app/middleware/account_kit_proof_headers_middleware.ts']
  ) {
    ownedChange(
      changes,
      state,
      'app/middleware/account_kit_proof_headers_middleware.ts',
      proofHeadersMiddlewareSource(choices),
      state.existingChoices ? proofHeadersMiddlewareSource(state.existingChoices) : null,
      'Protect proof responses before parser and CSRF failures'
    )
  }
  await planArrayImports(changes, state, diagnostics, 'adonisrc.ts', 'providers: [', [
    ...(choices.managed.length ? ['@adonisjs/core/providers/vinejs_provider'] : []),
    '@adonisjs/lucid/database_provider',
    '@adonisjs/limiter/limiter_provider',
    'adonisjs-account-kit/providers/account_kit_provider',
    ...(choices.managed.length ? ['@adonisjs/auth/auth_provider'] : []),
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
    if (choices.authentication?.strategy === 'session') {
      const shieldConfig = state.files['config/shield.ts']
      const csrf = shieldConfig ? await shieldCsrfState(shieldConfig) : 'missing'
      if (csrf === 'missing' || csrf === 'false')
        diagnostic(
          diagnostics,
          'config/shield.ts',
          'Session managed POSTs require configured Shield CSRF protection'
        )
      else if (csrf === 'dynamic')
        diagnostic(
          diagnostics,
          'config/shield.ts',
          'Verify that Shield csrf.enabled resolves true at runtime for the selected session guard; conventional environment-gated configuration requires ACCOUNT_KIT_AUTH_STRATEGY=session',
          'action'
        )
      if (!state.files['config/session.ts'])
        diagnostic(
          diagnostics,
          'config/session.ts',
          'Session guard requires configured cookie and session storage'
        )
      else {
        let inspected: NativeSessionConfiguration | null = null
        let diagnosticSelection: { name: string | null; kind: string | null } | null = null
        try {
          const current = state.files['config/session.ts']
          const baseline = current.includes('account-kit:session-import:start')
            ? await unwrapManagedSessionConfig(current, state.root)
            : current
          if (baseline) {
            inspected = await nativeSessionConfiguration(baseline, state.root)
            diagnosticSelection = inspected
              ? { name: inspected.selectedName, kind: inspected.selected?.kind ?? null }
              : await selectedSessionDiagnostic(baseline, state.root)
          }
        } catch {
          // The integration diagnostic above already blocks an uninspectable selection.
        }
        if (diagnosticSelection?.kind === 'cookie' || diagnosticSelection?.name === 'cookie')
          diagnostic(
            diagnostics,
            'config/session.ts',
            'Cookie-only sessions cannot enforce logout replay protection; select a server-side session store'
          )
        else if (options.production && diagnosticSelection?.kind === 'memory')
          diagnostic(
            diagnostics,
            'config/session.ts',
            'Production requires a persistent shared session store; selected memory storage cannot satisfy persistentStore verification'
          )
        else if (
          diagnosticSelection?.kind === 'database' &&
          !state.migrationNames.some((name) => /session/i.test(name))
        )
          diagnostic(
            diagnostics,
            'config/session.ts',
            'Database session storage requires an application session-table migration and a verified applied table',
            'action'
          )
        else if (diagnosticSelection?.name && !diagnosticSelection.kind)
          diagnostic(
            diagnostics,
            'config/session.ts',
            'Selected session store is not configured in config/session.ts'
          )
        else if (options.production && !diagnosticSelection?.kind)
          diagnostic(
            diagnostics,
            'config/session.ts',
            'Production session storage must be a verified persistent server-side store'
          )
        else if (!inspected?.selected)
          diagnostic(
            diagnostics,
            'config/session.ts',
            'Verify the selected runtime session store resolves to a server-side implementation and preserves logout revocation across requests',
            'action'
          )
      }
    }
  }
  const requiredMigrations = migrationNames.filter((name) => name !== 'create_social_identities')
  for (const [index, name] of requiredMigrations.entries()) {
    const suffix = `_account_kit_${name}.ts`
    const existing = state.migrationNames.find((filename) => filename.endsWith(suffix))
    const path = `database/migrations/${existing ?? `${options.timestamp ?? Date.now() + index}${suffix}`}`
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
  let endpointLocations: Array<{ name: string; method: string; path: string }> = []
  try {
    endpointLocations = selectedManagedRoutes(choices).map(({ name, method, path }) => ({
      name,
      method,
      path,
    }))
  } catch {
    // Invalid choices are reported above; preview remains inspectable.
  }
  const endpoints = endpointLocations.map(({ name }) => name)
  const selectedPackages = [
    'typescript',
    '@adonisjs/core',
    '@adonisjs/lucid',
    '@adonisjs/limiter',
    'adonisjs-account-kit',
    ...(choices.managed.length ? ['@adonisjs/auth', '@vinejs/vine'] : []),
    ...(choices.authentication?.strategy === 'session' && choices.managed.length
      ? ['@adonisjs/session', '@adonisjs/shield']
      : []),
    ...(hasEmailFlow(choices) && choices.mail.integration === 'adonisjs-mail'
      ? ['@adonisjs/mail']
      : []),
  ]
  const missingPackages = selectedPackages.filter((name) => !state.installedPackages.includes(name))
  for (const name of missingPackages)
    diagnostic(diagnostics, `dependencies.${name}`, `Install ${name} explicitly before applying`)
  const limiter = await limiterConfigurationState(
    state.files['config/limiter.ts'] ?? '',
    state.root
  )
  if (limiter === 'invalid')
    diagnostic(
      diagnostics,
      'config/limiter.ts',
      'Configure @adonisjs/limiter with pnpm exec node ace configure @adonisjs/limiter; config/limiter.ts needs an actual selected store in its exported defineConfig'
    )
  else if (limiter === 'unresolved')
    diagnostic(
      diagnostics,
      'config/limiter.ts',
      'Selected limiter store is unresolved; use a direct literal or a resolvable environment assignment before activation'
    )
  const minimumVersions: Record<string, readonly [number, number, number]> = {
    '@adonisjs/core': [7, 0, 0],
    '@adonisjs/lucid': [22, 4, 2],
    '@adonisjs/limiter': [3, 0, 0],
    '@adonisjs/auth': [10, 1, 0],
    '@adonisjs/session': [8, 1, 0],
    '@adonisjs/shield': [9, 0, 0],
    '@vinejs/vine': [4, 4, 0],
    '@adonisjs/mail': [10, 0, 0],
  }
  for (const name of selectedPackages) {
    if (name === 'typescript') {
      const version = state.installedVersions[name]
      const parts = version
        ?.match(/^(\d+)\.(\d+)\.(\d+)$/)
        ?.slice(1)
        .map(Number)
      const supported =
        parts &&
        ((parts[0] === 5 && (parts[1] > 9 || (parts[1] === 9 && parts[2] >= 3))) ||
          (parts[0] === 6 && (parts[1] > 0 || parts[2] >= 3)))
      if (!supported)
        diagnostic(
          diagnostics,
          'dependencies.typescript',
          `Installed TypeScript version ${version ?? 'unknown'} is outside supported ^5.9.3 || ^6.0.3 range`
        )
      continue
    }
    const minimum = minimumVersions[name]
    if (!minimum) continue
    const version = state.installedVersions[name]
    if (!version) continue
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/)
    const parts = match?.slice(1).map(Number)
    if (
      !parts ||
      parts[0] !== minimum[0] ||
      parts[1] < minimum[1] ||
      (parts[1] === minimum[1] && parts[2] < minimum[2])
    )
      diagnostic(
        diagnostics,
        `dependencies.${name}`,
        `Installed ${name}@${version} is outside supported ^${minimum.join('.')} range`
      )
  }
  const csrfLocation = endpointLocations.find(({ name }) => name === 'auth.csrf')?.path
  const prerequisites = [
    ...missingPackages.map((name) => `Install ${name} explicitly with pnpm add ${name}`),
    'Review generated migrations, then run node ace migration:run explicitly',
    ...(choices.managed.length
      ? ['Verify the generated route mount and existing guard prerequisites']
      : []),
    ...(choices.managed.length && choices.authentication?.strategy === 'session'
      ? [
          csrfLocation
            ? `Exercise GET ${csrfLocation} and a CSRF-protected POST with the deployed Shield configuration`
            : 'Provide and exercise an application-owned CSRF bootstrap endpoint and a CSRF-protected POST with the deployed Shield configuration',
        ]
      : []),
    'Verify model email uniqueness, normalization, hashing and transaction behavior',
  ]
  const hasError = diagnostics.some((item) => item.severity === 'error')
  const hasAction = diagnostics.some((item) => item.severity === 'action')
  return {
    choices,
    preview: options.apply !== true,
    changes,
    diagnostics,
    differences: state.existingChoices ? changedFields(state.existingChoices, choices) : [],
    retirementImpact: options.retirementImpact ?? null,
    prerequisites,
    endpoints: [...new Set(endpoints)],
    endpointLocations,
    migrationState: !state.migrationNames.some((file) => file.includes('_account_kit_'))
      ? 'not-generated'
      : requiredMigrations.every((name) =>
            state.migrationNames.some((file) => file.endsWith(`_account_kit_${name}.ts`))
          )
        ? 'generated-application-unknown'
        : 'partially-generated',
    readiness: {
      configurationGenerated: changes.every((change) => change.action === 'unchanged'),
      configurationValid: !hasError,
      migrationsApplied: false,
      externalConfigured: !hasError && !hasAction,
      workflowVerified: false,
      productionReady: false,
      delivery: !hasEmailFlow(choices)
        ? 'not applicable'
        : choices.mail.delivery === 'durable'
          ? 'durable'
          : 'best effort',
    },
    pillars: {
      features: `${choices.features.length} services; ${choices.managed.length} managed groups`,
      user: `${choices.user.model} / ${choices.user.table} / ${choices.user.idType}`,
      authentication: choices.authentication
        ? `${choices.authentication.strategy} guard ${choices.authentication.guard}`
        : 'not applicable: no authentication endpoints selected',
      mail: hasEmailFlow(choices)
        ? `${choices.mail.integration}; ${choices.mail.delivery}`
        : 'not applicable: no email capability selected',
      social:
        choices.social.status === 'approved-pending'
          ? 'approved, pending installed implementation'
          : `not applicable: ${choices.social.reason}`,
      policy: `${choices.policy.registration} registration; verification ${choices.policy.verificationRequired ? 'required' : 'optional'}`,
    },
  }
}
