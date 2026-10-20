import type { SetupChoices, SetupDiagnostic, SetupInspection } from './types.js'
import { isSocialProviderName } from '../social_providers.js'
import type { SocialProviderName } from '../types.js'
import { envName, diagnostic, validateOrigin } from './shared.js'
import type { SelectedSetupOrigins } from './diagnostics.js'

/** Social providers, callbacks, credential references and Ally prerequisites. */
export function validateSocial(
  diagnostics: SetupDiagnostic[],
  choices: SetupChoices,
  state: SetupInspection,
  production: boolean,
  env: NodeJS.ProcessEnv,
  selectedOrigins?: SelectedSetupOrigins
) {
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
      production,
      env,
      selectedOrigins?.values[choices.social.callbackOriginEnv],
      selectedOrigins?.errors[choices.social.callbackOriginEnv]
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
      for (const [key, variable] of Object.entries(refs))
        if (!env[variable])
          diagnostic(
            diagnostics,
            `social.credentials.${provider}.${key}`,
            `${variable} must be set before readiness can pass`,
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
}
