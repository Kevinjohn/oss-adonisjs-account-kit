import { readFile } from 'node:fs/promises'
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

const emailDestinations: Partial<Record<SetupFeature, keyof SetupChoices['mail']['destinations']>> =
  {
    registration: 'emailVerification',
    emailVerification: 'emailVerification',
    passwordReset: 'passwordReset',
    invitations: 'invitation',
    emailPasswordManagement: 'emailChange',
  }

const knownEndpoints: Record<SetupFeature, string[]> = {
  registration: ['auth.signup'],
  authentication: [
    'auth.login',
    'account.logout',
    'account.profile.show',
    'account.profile.update',
  ],
  passwordReset: [
    'auth.passwordReset.request',
    'auth.passwordReset.inspect',
    'auth.passwordReset.complete',
  ],
  emailVerification: [
    'auth.emailVerification.inspect',
    'auth.emailVerification.complete',
    'account.emailVerification.send',
  ],
  emailPasswordManagement: [
    'auth.emailChange.inspect',
    'auth.emailChange.complete',
    'account.password.change',
  ],
  invitations: [
    'auth.invitation.inspect',
    'auth.invitation.accept',
    'account.invitation.send',
    'account.invitation.list',
    'account.invitation.resend',
    'account.invitation.revoke',
  ],
}

const envName = /^[A-Z][A-Z0-9_]*$/
const sqlName = /^[A-Za-z_][A-Za-z0-9_]*$/
const routePrefix = /^\/[A-Za-z0-9/_-]*$/

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
  if (
    state.routePaths.some(
      (path) => path === choices.routePrefix || path.startsWith(`${choices.routePrefix}/`)
    )
  )
    diagnostic(
      diagnostics,
      'routePrefix',
      'An application route already uses this prefix; choose a different prefix or remove the route before applying'
    )
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
  if (choices.managed.includes('registration') && choices.policy.registration !== 'open')
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
  if (!['adonisjs-mail', 'custom'].includes(choices.mail.integration))
    diagnostic(diagnostics, 'mail.integration', 'Choose adonisjs-mail or custom')
  if (!['best-effort', 'durable'].includes(choices.mail.delivery))
    diagnostic(diagnostics, 'mail.delivery', 'Choose best-effort or durable')
  for (const field of ['senderEnv', 'transportEnv'] as const) {
    const name = choices.mail[field]
    if (name && !envName.test(name))
      diagnostic(
        diagnostics,
        `mail.${field}`,
        'Use an uppercase environment variable name, not a secret'
      )
  }
  if (choices.mail.integration === 'adonisjs-mail' && !state.files['config/mail.ts'])
    diagnostic(
      diagnostics,
      'config/mail.ts',
      'Configure AdonisJS Mail with a real transport before applying'
    )
  if (
    choices.mail.integration === 'custom' &&
    !state.files['app/services/account_kit_notifications.ts']
  )
    diagnostic(
      diagnostics,
      'mail.integration',
      'Provide #services/account_kit_notifications before activation'
    )
  if (!choices.mail.appName.trim())
    diagnostic(diagnostics, 'mail.appName', 'Application identity is required')
  if (choices.mail.integration === 'adonisjs-mail' && !choices.mail.senderEnv)
    diagnostic(diagnostics, 'mail.senderEnv', 'Sender environment reference is required')
  if (choices.mail.integration === 'adonisjs-mail' && !choices.mail.transportEnv)
    diagnostic(diagnostics, 'mail.transportEnv', 'Transport environment reference is required')
  if (choices.mail.integration === 'adonisjs-mail') {
    for (const field of ['senderEnv', 'transportEnv'] as const) {
      const name = choices.mail[field]
      if (name && envName.test(name) && !process.env[name])
        diagnostic(
          diagnostics,
          `mail.${field}`,
          `${name} must be set before readiness can pass`,
          'action'
        )
    }
  }
  for (const [feature, destination] of Object.entries(emailDestinations)) {
    if (
      choices.features.includes(feature as SetupFeature) &&
      !choices.mail.destinations[destination!]
    )
      diagnostic(
        diagnostics,
        `mail.destinations.${destination}`,
        'Enabled email flow needs a relative frontend destination'
      )
  }
  for (const [field, destination] of Object.entries(choices.mail.destinations)) {
    if (
      destination &&
      (destination.startsWith('/') ||
        destination.startsWith('//') ||
        destination.includes('..') ||
        destination.includes('\\') ||
        destination.includes('?') ||
        destination.includes('#') ||
        /^[a-z][a-z\d+.-]*:/i.test(destination))
    )
      diagnostic(
        diagnostics,
        `mail.destinations.${field}`,
        'Use a safe relative path without query or fragment'
      )
  }
  validateOrigin(diagnostics, 'mail.backendOriginEnv', choices.mail.backendOriginEnv, production)
  validateOrigin(diagnostics, 'mail.frontendOriginEnv', choices.mail.frontendOriginEnv, production)
  if (choices.mail.delivery === 'durable' && !choices.mail.durableWorkerVerified)
    diagnostic(
      diagnostics,
      'mail.durableWorkerVerified',
      'Verify application-owned queue/outbox worker and retry before durable readiness'
    )
  if (choices.mail.delivery === 'durable' && choices.mail.integration !== 'custom')
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
  const names = new Set<string>([choices.mail.backendOriginEnv, choices.mail.frontendOriginEnv])
  if (choices.mail.senderEnv) names.add(choices.mail.senderEnv)
  if (choices.mail.transportEnv) names.add(choices.mail.transportEnv)
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
    `  verificationRequired: ${choices.policy.verificationRequired},`,
    '  kit: () => app.container.make(AccountKit),',
    '  guard: accountKitGuard,',
    '})',
    '',
  ].join('\n')
}

function disabledManagedRoutesSource(): string {
  return '// Account Kit managed endpoints are disabled by setup.\n'
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

function accountConfigSource(choices: SetupChoices): string {
  const managedMail = choices.mail.integration === 'adonisjs-mail'
  const serviceCapabilities = choices.features.filter((name) => name !== 'authentication')
  const usesPolicy =
    choices.policy.accessRestrictionHook || choices.features.includes('invitations')
  const imports = [
    "import env from '#start/env'",
    "import app from '@adonisjs/core/services/app'",
    ...(managedMail ? ["import mail from '@adonisjs/mail/services/main'"] : []),
    `import { ${[
      'createActionUrls',
      'defineConfig',
      ...(choices.user.adapter === 'lucid' ? ['createLucidAdapter'] : []),
      ...(managedMail ? ['createMailNotifications'] : []),
    ].join(', ')} } from 'adonisjs-account-kit'`,
    ...(choices.user.adapter === 'custom'
      ? ["import users from '#services/account_kit_users'"]
      : []),
    ...(managedMail
      ? []
      : ["import { accountKitNotifications } from '#services/account_kit_notifications'"]),
    ...(usesPolicy ? ["import { accountKitPolicy } from '#services/account_kit_policy'"] : []),
    ...(choices.policy.registrationFields.length
      ? ["import { InvalidInputError } from 'adonisjs-account-kit/errors'"]
      : []),
    '',
    'const requiredEnv = (name: string): string => {',
    '  const value = process.env[name]',
    '  if (!value) throw new Error(`account_kit: ${name} must be configured`)',
    '  return value',
    '}',
    ...(choices.policy.registrationFields.length
      ? [
          '',
          `const registrationFields = ${JSON.stringify(choices.policy.registrationFields)} as const`,
          'const mapRegistrationFields = (input: unknown): Record<string, unknown> => {',
          "  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new InvalidInputError('account_kit: registrationData must be an object')",
          '  const source = (input ?? {}) as Record<string, unknown>',
          '  const output: Record<string, unknown> = {}',
          '  for (const key of Object.keys(source)) if (!registrationFields.some((field) => field.name === key)) throw new InvalidInputError(`account_kit: registrationData.${key} is not allowed`)',
          '  for (const field of registrationFields) {',
          '    const value = source[field.name]',
          '    if (value === undefined) {',
          '      if (field.required) throw new InvalidInputError(`account_kit: registrationData.${field.name} is required`)',
          '      continue',
          '    }',
          '    if (typeof value !== field.type) throw new InvalidInputError(`account_kit: registrationData.${field.name} must be ${field.type}`)',
          "    if (field.type === 'string' && typeof value === 'string' && 'maxLength' in field && value.length > field.maxLength) throw new InvalidInputError(`account_kit: registrationData.${field.name} is too long`)",
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
            '      if (field.name in fields) (user as unknown as Record<string, unknown>)[field.name] = fields[field.name]',
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
    `  delivery: ${JSON.stringify(choices.mail.delivery)},`,
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
    '  urls: createActionUrls({',
    `    backendOrigin: requiredEnv(${JSON.stringify(choices.mail.backendOriginEnv)}),`,
    `    appFrontendUrl: requiredEnv(${JSON.stringify(choices.mail.frontendOriginEnv)}),`,
    "    environment: app.inProduction ? 'production' : app.inTest ? 'test' : 'development',",
    `    destinations: ${JSON.stringify(choices.mail.destinations)},`,
    '  }),',
    ...(managedMail
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

function planRouteImport(
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
  const importLine = "import './account_kit_routes.js'"
  if (previous.includes(importLine)) {
    changes.push({
      path,
      action: 'unchanged',
      content: previous,
      reason: 'Managed route mount is already active',
    })
    return
  }
  if (previous.includes('account_kit_routes')) {
    diagnostic(diagnostics, path, 'Existing Account Kit route import differs; resolve it manually')
    return
  }
  changes.push({
    path,
    action: 'update',
    expected: previous,
    content: `${previous.trimEnd()}\n\n${importLine}\n`,
    reason: 'Explicitly mount the package-maintained endpoints',
  })
}

function planArrayImports(
  changes: SetupFileChange[],
  state: SetupInspection,
  diagnostics: SetupDiagnostic[],
  path: string,
  marker: string,
  imports: string[]
) {
  const previous = state.files[path]
  if (previous === undefined || !previous.includes(marker)) {
    diagnostic(
      diagnostics,
      path,
      `Expected ${marker} in ${path}; configure these imports manually before activation`
    )
    return
  }
  const missing = imports.filter((name) => !previous.includes(name))
  if (!missing.length) {
    changes.push({
      path,
      action: 'unchanged',
      content: previous,
      reason: 'Required imports are already present',
    })
    return
  }
  changes.push({
    path,
    action: 'update',
    expected: previous,
    content: previous.replace(
      marker,
      `${marker}\n${missing.map((name) => `    () => import('${name}'),`).join('\n')}`
    ),
    reason: 'Register required framework providers or middleware',
  })
}

function planRouterMiddleware(
  changes: SetupFileChange[],
  state: SetupInspection,
  diagnostics: SetupDiagnostic[],
  session: boolean
) {
  const path = 'start/kernel.ts'
  const previous = state.files[path]
  const start = previous?.indexOf('router.use([') ?? -1
  const end = start < 0 ? -1 : previous!.indexOf('])', start)
  if (!previous || start < 0 || end < 0 || previous.indexOf('router.use([', start + 1) >= 0) {
    diagnostic(diagnostics, path, 'Expected one conventional router.use array in start/kernel.ts')
    return
  }
  const block = previous.slice(start + 'router.use(['.length, end)
  const serverStart = previous.indexOf('server.use([')
  const serverEnd = serverStart < 0 ? -1 : previous.indexOf('])', serverStart)
  const serverBlock = serverEnd < 0 ? '' : previous.slice(serverStart, serverEnd)
  const lines = block.split('\n')
  const body = '@adonisjs/core/bodyparser_middleware'
  const ordered = [
    body,
    ...(session
      ? ['@adonisjs/session/session_middleware', '@adonisjs/shield/shield_middleware']
      : []),
    '@adonisjs/auth/initialize_auth_middleware',
  ]
  if (ordered.slice(1).some((name) => serverBlock.includes(name))) {
    diagnostic(
      diagnostics,
      path,
      'Account middleware already appears in server.use; move it to the ordered router.use stack manually'
    )
    return
  }
  if (
    lines.filter((line) => line.includes(body)).length !== 1 ||
    ordered.some((name) => lines.filter((line) => line.includes(name)).length > 1)
  ) {
    diagnostic(
      diagnostics,
      path,
      'Router middleware layout is ambiguous; preserve body parser, session, Shield, then auth order manually'
    )
    return
  }
  const existingIndexes = ordered
    .map((name) => lines.findIndex((line) => line.includes(name)))
    .filter((index) => index >= 0)
  if (
    existingIndexes.some(
      (index, position) => position > 0 && index <= existingIndexes[position - 1]
    )
  ) {
    diagnostic(
      diagnostics,
      path,
      'Existing router middleware order is unsafe; require body parser, session, Shield, then auth'
    )
    return
  }
  let changed = false
  for (let index = 1; index < ordered.length; index++) {
    if (lines.some((line) => line.includes(ordered[index]))) continue
    const previousIndex = lines.findIndex((line) => line.includes(ordered[index - 1]))
    if (previousIndex < 0) throw new Error('Missing previously planned router middleware')
    lines.splice(previousIndex + 1, 0, `  () => import('${ordered[index]}'),`)
    changed = true
  }
  changes.push({
    path,
    action: changed ? 'update' : 'unchanged',
    expected: previous,
    content: changed
      ? previous.slice(0, start + 'router.use(['.length) + lines.join('\n') + previous.slice(end)
      : previous,
    reason: 'Keep account middleware after body parsing on registered routes',
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
    choices.user.adapter === 'lucid' &&
    /^#models\/[A-Za-z_][A-Za-z0-9_/]*$/.test(choices.user.model) &&
    !choices.user.model.includes('//')
  ) {
    const modelPath = `app/models/${choices.user.model.slice('#models/'.length)}.ts`
    try {
      const model = await readFile(await safeSetupPath(state.root, modelPath), 'utf8')
      if (!/export\s+default\s+class\s+\w+\s+extends\s+/.test(model))
        diagnostic(
          diagnostics,
          'user.model',
          'Selected Lucid model must expose a default model class'
        )
      if (
        choices.authentication?.strategy === 'access_tokens' &&
        !/static\s+accessTokens\s*=/.test(model)
      )
        diagnostic(
          diagnostics,
          'user.model',
          'Token guard model must expose its existing static accessTokens provider'
        )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      diagnostic(diagnostics, 'user.model', `${modelPath} was not found`)
    }
  }
  const changes: SetupFileChange[] = []
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
  if (choices.managed.length && choices.authentication) {
    ownedChange(
      changes,
      state,
      'app/services/account_kit_guard.ts',
      managedGuardSource(choices),
      state.existingChoices?.authentication ? managedGuardSource(state.existingChoices) : null,
      'Adapt the selected existing AdonisJS guard'
    )
    ownedChange(
      changes,
      state,
      'app/middleware/account_kit_access_middleware.ts',
      managedAccessMiddlewareSource(choices),
      state.existingChoices?.authentication && state.existingChoices.managed.length
        ? managedAccessMiddlewareSource(state.existingChoices)
        : null,
      'Offer the same account revision and restriction gate to application-owned routes'
    )
    ownedChange(
      changes,
      state,
      'start/account_kit_routes.ts',
      managedRoutesSource(choices),
      state.existingChoices?.authentication
        ? state.existingChoices.managed.length
          ? managedRoutesSource(state.existingChoices)
          : disabledManagedRoutesSource()
        : null,
      'Mount selected maintained endpoints through the existing guard'
    )
  } else if (state.existingChoices?.managed.length && state.existingChoices.authentication) {
    ownedChange(
      changes,
      state,
      'start/account_kit_routes.ts',
      disabledManagedRoutesSource(),
      managedRoutesSource(state.existingChoices),
      'Retire the managed route mount without changing application routes or account data'
    )
  }
  planArrayImports(changes, state, diagnostics, 'adonisrc.ts', 'providers: [', [
    '@adonisjs/core/providers/vinejs_provider',
    '@adonisjs/lucid/database_provider',
    '@adonisjs/limiter/limiter_provider',
    'adonisjs-account-kit/providers/account_kit_provider',
    ...(choices.managed.length ? ['@adonisjs/auth/auth_provider'] : []),
    ...(choices.authentication?.strategy === 'session' && choices.managed.length
      ? ['@adonisjs/session/session_provider', '@adonisjs/shield/shield_provider']
      : []),
    ...(choices.mail.integration === 'adonisjs-mail' ? ['@adonisjs/mail/mail_provider'] : []),
  ])
  if (choices.managed.length) {
    planRouterMiddleware(
      changes,
      state,
      diagnostics,
      choices.authentication?.strategy === 'session'
    )
    if (choices.authentication?.strategy === 'session') {
      const shieldConfig = state.files['config/shield.ts']
      if (!shieldConfig || /csrf\s*:\s*\{[^}]*enabled\s*:\s*false/s.test(shieldConfig))
        diagnostic(
          diagnostics,
          'config/shield.ts',
          'Session managed POSTs require configured Shield CSRF protection'
        )
      else if (!/csrf\s*:\s*\{[^}]*enabled\s*:\s*true\b/s.test(shieldConfig))
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
  if (choices.managed.length && choices.authentication) planRouteImport(changes, state, diagnostics)
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
  }
  const endpoints = choices.managed.flatMap((feature) => knownEndpoints[feature])
  if (choices.authentication?.strategy === 'session' && choices.managed.includes('authentication'))
    endpoints.push('auth.csrf')
  if (
    choices.authentication?.strategy === 'session' &&
    choices.managed.length &&
    !choices.managed.includes('authentication')
  )
    diagnostic(
      diagnostics,
      'authentication.csrfBootstrap',
      'Session managed POST routes require an application-owned CSRF bootstrap endpoint because the managed authentication group is disabled',
      'action'
    )
  const missingPackages = [
    '@adonisjs/core',
    '@adonisjs/lucid',
    '@adonisjs/limiter',
    'adonisjs-account-kit',
    ...(choices.managed.length ? ['@adonisjs/auth', '@vinejs/vine'] : []),
    ...(choices.authentication?.strategy === 'session' && choices.managed.length
      ? ['@adonisjs/session', '@adonisjs/shield']
      : []),
    ...(choices.mail.integration === 'adonisjs-mail' ? ['@adonisjs/mail'] : []),
  ].filter((name) => !state.installedPackages.includes(name))
  for (const name of missingPackages)
    diagnostic(diagnostics, `dependencies.${name}`, `Install ${name} explicitly before applying`)
  const supportedMajors: Record<string, number> = {
    '@adonisjs/core': 7,
    '@adonisjs/lucid': 22,
    '@adonisjs/limiter': 3,
    '@adonisjs/auth': 10,
    '@adonisjs/session': 8,
    '@adonisjs/shield': 9,
    '@vinejs/vine': 4,
    '@adonisjs/mail': 10,
  }
  for (const [name, major] of Object.entries(supportedMajors)) {
    const version = state.installedVersions[name]
    if (version && Number(version.match(/^(\d+)\./)?.[1]) !== major)
      diagnostic(
        diagnostics,
        `dependencies.${name}`,
        `Installed ${name}@${version} is outside supported major ${major}`
      )
  }
  const prerequisites = [
    ...missingPackages.map((name) => `Install ${name} explicitly with pnpm add ${name}`),
    'Review generated migrations, then run node ace migration:run explicitly',
    ...(choices.managed.length
      ? ['Verify the generated route mount and existing guard prerequisites']
      : []),
    ...(choices.managed.length && choices.authentication?.strategy === 'session'
      ? ['Exercise GET /auth/csrf and a CSRF-protected POST with the deployed Shield configuration']
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
      delivery: choices.mail.delivery === 'durable' ? 'durable' : 'best effort',
    },
    pillars: {
      features: `${choices.features.length} services; ${choices.managed.length} managed groups`,
      user: `${choices.user.model} / ${choices.user.table} / ${choices.user.idType}`,
      authentication: choices.authentication
        ? `${choices.authentication.strategy} guard ${choices.authentication.guard}`
        : 'not applicable: no authentication endpoints selected',
      mail: `${choices.mail.integration}; ${choices.mail.delivery}`,
      social:
        choices.social.status === 'approved-pending'
          ? 'approved, pending installed implementation'
          : `not applicable: ${choices.social.reason}`,
      policy: `${choices.policy.registration} registration; verification ${choices.policy.verificationRequired ? 'required' : 'optional'}`,
    },
  }
}
