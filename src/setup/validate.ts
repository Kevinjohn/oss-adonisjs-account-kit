import {
  type SetupChoices,
  type SetupDiagnostic,
  type SetupFeature,
  type SetupInspection,
  type SetupPlan,
  featureNames,
} from './types.js'
import { planManagedRoutes, type ManagedRoute } from '../http/routes.js'
import { createActionUrls } from '../notifications.js'
import { isSocialProviderName } from '../social_providers.js'
import type { SocialProviderName } from '../types.js'
import {
  emailDestinations,
  hasEmailFlow,
  envName,
  sqlName,
  routePrefix,
  selectedManagedRoutes,
  diagnostic,
  validateOrigin,
} from './shared.js'

export type RetirementOptions = {
  retirementImpact: SetupPlan['retirementImpact']
  retirementMaintenanceWindow: boolean
  runtimeInventoryUnavailable: boolean
}

export type ValidateOptions = RetirementOptions & { production: boolean }

export function validate(choices: SetupChoices, state: SetupInspection, options: ValidateOptions) {
  const { production } = options
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
    diagnostic(
      diagnostics,
      'database.client',
      'Resolve the selected SQLite or PostgreSQL 16 client before setup'
    )
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
  if (choices.features.includes('magicLinkLogin') && !choices.authentication)
    diagnostic(
      diagnostics,
      'authentication',
      'Magic-link sign-in requires a selected existing guard'
    )
  if (choices.features.includes('sessionManagement') && !choices.authentication)
    diagnostic(
      diagnostics,
      'authentication',
      'Session management requires a selected existing guard'
    )
  if (choices.features.includes('accountDeletion') && !hasEmailFlow(choices))
    diagnostic(
      diagnostics,
      'features',
      'Account deletion sends a confirmation email; also select an email service such as passwordReset'
    )
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
    if (
      choices.authentication.strategy === 'access_tokens' &&
      state.guardTokenProviders[choices.authentication.guard] !== 'accessTokens'
    )
      diagnostic(
        diagnostics,
        'authentication.guard',
        'Selected token guard must use the model accessTokens provider'
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
        'Generated managed routes remain disabled until application-owned protected routes use the account-access middleware and revocation is verified; rerun setup with this choice true to activate',
        'action'
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
  if (choices.social.status === 'enabled') {
    if (
      !choices.social.providers.length ||
      choices.social.providers.some((provider) => !isSocialProviderName(provider)) ||
      new Set(choices.social.providers).size !== choices.social.providers.length
    )
      diagnostic(diagnostics, 'social.providers', 'Select unique Google and/or GitHub providers')
    if (!choices.features.includes('socialAuthentication'))
      diagnostic(diagnostics, 'features', 'Selected social providers require socialAuthentication')
    if (
      !choices.features.includes('registration') ||
      !choices.features.includes('emailVerification')
    )
      diagnostic(
        diagnostics,
        'features',
        'Social creation requires registration and emailVerification'
      )
    if (!choices.features.includes('passwordReset'))
      diagnostic(
        diagnostics,
        'social.sensitiveActions',
        'Standard Ally callbacks do not prove fresh authentication. Enable passwordReset so social-only users can establish a first password, sign in with it, then re-enter it for purpose-bound sensitive-action proof'
      )
    if (!choices.authentication)
      diagnostic(diagnostics, 'authentication', 'Social authentication requires a selected guard')
    if (choices.mode === 'managed' && !choices.managed.includes('socialAuthentication'))
      diagnostic(
        diagnostics,
        'managed',
        'Selected managed social providers require managed socialAuthentication'
      )
    validateOrigin(
      diagnostics,
      'social.callbackOriginEnv',
      choices.social.callbackOriginEnv,
      production
    )
    if (
      !choices.social.callbackPath.startsWith('/') ||
      !choices.social.callbackPath.includes('{provider}') ||
      choices.social.callbackPath.includes('?') ||
      choices.social.callbackPath.includes('#') ||
      choices.social.callbackPath.includes('..') ||
      choices.social.callbackPath.includes('\\') ||
      choices.social.callbackPath.startsWith('//')
    )
      diagnostic(
        diagnostics,
        'social.callbackPath',
        'Use a safe absolute path containing {provider}'
      )
    if (
      choices.authentication?.strategy === 'session' &&
      choices.social.callbackPath !== `${choices.routePrefix}/auth/oauth/{provider}/callback`
    )
      diagnostic(
        diagnostics,
        'social.callbackPath',
        'Session callbacks must use the managed callback route'
      )
    if (choices.policy.registration === 'application' && choices.mode === 'managed')
      diagnostic(
        diagnostics,
        'social.admission',
        'Application registration requires a trusted server admit extension; generated managed completion is excluded until supplied',
        'action'
      )
    for (const provider of choices.social.providers) {
      const refs = choices.social.credentials[provider]
      if (!refs || !envName.test(refs.clientIdEnv) || !envName.test(refs.clientSecretEnv)) {
        diagnostic(
          diagnostics,
          `social.credentials.${provider}`,
          'Provide credential environment variable names for this provider'
        )
        continue
      }
      for (const [key, env] of Object.entries(refs))
        if (!process.env[env])
          diagnostic(
            diagnostics,
            `social.credentials.${provider}.${key}`,
            `${env} must be set before readiness can pass`,
            'action'
          )
    }
    for (const name of Object.keys(choices.social.credentials))
      if (!choices.social.providers.includes(name as SocialProviderName))
        diagnostic(
          diagnostics,
          `social.credentials.${name}`,
          'Disabled providers must not carry credential references'
        )
    if (!state.installedPackages.includes('@adonisjs/ally'))
      diagnostic(
        diagnostics,
        'social',
        'Install @adonisjs/ally before activating social sign-in',
        'action'
      )
    if (!state.files['config/ally.ts'])
      diagnostic(
        diagnostics,
        'config/ally.ts',
        'Configure selected providers in Ally with the displayed callbacks',
        'action'
      )
  }
  if (
    choices.social.status === 'not-applicable' &&
    choices.features.includes('socialAuthentication')
  )
    diagnostic(diagnostics, 'social', 'Enabled socialAuthentication requires selected providers')
  retirementDiagnostics(diagnostics, choices, state, options)
  if (state.existingPrefix && state.existingPrefix !== choices.routePrefix)
    diagnostic(
      diagnostics,
      'routePrefix',
      'Changing the managed prefix needs an explicit route transition; review clients before reconfiguration',
      'action'
    )
  return diagnostics
}

/** Blocks login-method retirement unless the read-only inventory proves it is safe. */
function retirementDiagnostics(
  diagnostics: SetupDiagnostic[],
  choices: SetupChoices,
  state: SetupInspection,
  { retirementImpact, retirementMaintenanceWindow, runtimeInventoryUnavailable }: RetirementOptions
) {
  const beforeProviders =
    retirementImpact?.currentProviders ??
    (state.existingChoices?.social.status === 'enabled'
      ? state.existingChoices.social.providers
      : [])
  const afterProviders = choices.social.status === 'enabled' ? choices.social.providers : []
  const providerRetirement = beforeProviders.some((provider) => !afterProviders.includes(provider))
  const passwordRetirement =
    (retirementImpact?.currentPasswordLogin ?? Boolean(state.existingChoices?.authentication)) &&
    !choices.authentication
  if (runtimeInventoryUnavailable && state.existingChoices)
    diagnostic(
      diagnostics,
      'authentication.retirement',
      'Booted login-method inventory is unavailable; verify Account Kit configuration and database access before reconfiguration'
    )
  if (providerRetirement || passwordRetirement) {
    const field = providerRetirement ? 'social.retirement' : 'authentication.retirement'
    if (!retirementImpact)
      diagnostic(
        diagnostics,
        field,
        'Read-only retirement impact count is unavailable; verify Account Kit provider, configuration and database access, then retry'
      )
    else if (retirementImpact.affectedAccounts > 0)
      diagnostic(
        diagnostics,
        field,
        `${retirementImpact.affectedAccounts} of ${retirementImpact.inspectedAccounts} accounts would lose their last usable login; complete an owner-managed credential migration before retrying`
      )
    else if (!retirementMaintenanceWindow)
      diagnostic(
        diagnostics,
        field,
        'Zero affected accounts were found, but retirement requires --retirement-maintenance-window to prevent concurrent credential changes'
      )
  }
}
