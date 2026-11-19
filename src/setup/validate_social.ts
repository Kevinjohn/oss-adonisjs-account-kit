import type { SetupChoices, SetupDiagnostic, SetupInspection } from './types.js'
import { isSocialProviderName } from '../social_providers.js'
import type { SocialProviderName } from '../types.js'
import { envName, addSetupDiagnostic, addOriginDiagnostics } from './shared.js'
import type { SelectedSetupOrigins } from './diagnostics.js'

/** The substituted path must survive URL parsing without traversal or encoded separators. */
function safeCallbackPath(path: string): boolean {
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.split('{provider}').length !== 2 ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('..') ||
    path.includes('\\')
  )
    return false
  const substituted = path.replace('{provider}', 'github')
  try {
    for (const segment of substituted.split('/')) {
      const decoded = decodeURIComponent(segment)
      if (
        decoded === '.' ||
        decoded === '..' ||
        decoded.includes('/') ||
        decoded.includes('\\') ||
        [...decoded].some(
          (character) =>
            /\s/u.test(character) || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )
      )
        return false
    }
    return new URL(substituted, 'https://callback.example.test').pathname === substituted
  } catch {
    return false
  }
}

/** Social providers, callbacks, credential references and Ally prerequisites. */
export function addSocialDiagnostics(
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
      addSetupDiagnostic(
        diagnostics,
        'social.providers',
        'Select unique Google and/or GitHub providers'
      )
    if (!choices.features.includes('socialAuthentication'))
      addSetupDiagnostic(
        diagnostics,
        'features',
        'Selected social providers require socialAuthentication'
      )
    if (
      !choices.features.includes('registration') ||
      !choices.features.includes('emailVerification')
    )
      addSetupDiagnostic(
        diagnostics,
        'features',
        'Social creation requires registration and emailVerification'
      )
    if (!choices.features.includes('passwordReset'))
      addSetupDiagnostic(
        diagnostics,
        'social.sensitiveActions',
        'Standard Ally callbacks do not prove fresh authentication. Enable passwordReset so social-only users can establish a first password, sign in with it, then re-enter it for purpose-bound sensitive-action proof'
      )
    if (!choices.authentication)
      addSetupDiagnostic(
        diagnostics,
        'authentication',
        'Social authentication requires a selected guard'
      )
    if (choices.mode === 'managed' && !choices.managed.includes('socialAuthentication'))
      addSetupDiagnostic(
        diagnostics,
        'managed',
        'Selected managed social providers require managed socialAuthentication'
      )
    addOriginDiagnostics(
      diagnostics,
      'social.callbackOriginEnv',
      choices.social.callbackOriginEnv,
      {
        production,
        env,
        resolvedValue: selectedOrigins?.values[choices.social.callbackOriginEnv],
        resolutionError: selectedOrigins?.errors[choices.social.callbackOriginEnv],
      }
    )
    if (!safeCallbackPath(choices.social.callbackPath))
      addSetupDiagnostic(
        diagnostics,
        'social.callbackPath',
        'Use a safe absolute path containing exactly one {provider}'
      )
    if (
      choices.authentication?.strategy === 'session' &&
      choices.social.callbackPath !== `${choices.routePrefix}/auth/oauth/{provider}/callback`
    )
      addSetupDiagnostic(
        diagnostics,
        'social.callbackPath',
        'Session callbacks must use the managed callback route'
      )
    if (choices.policy.registration === 'application' && choices.mode === 'managed')
      addSetupDiagnostic(
        diagnostics,
        'social.admission',
        'Application registration requires a trusted server admit extension; generated managed completion is excluded until supplied',
        'action'
      )
    for (const provider of choices.social.providers) {
      const refs = choices.social.credentials[provider]
      if (!refs || !envName.test(refs.clientIdEnv) || !envName.test(refs.clientSecretEnv)) {
        addSetupDiagnostic(
          diagnostics,
          `social.credentials.${provider}`,
          'Provide credential environment variable names for this provider'
        )
        continue
      }
      for (const [key, variable] of Object.entries(refs))
        if (!env[variable])
          addSetupDiagnostic(
            diagnostics,
            `social.credentials.${provider}.${key}`,
            `${variable} must be set before readiness can pass`,
            'action'
          )
    }
    for (const name of Object.keys(choices.social.credentials))
      if (!choices.social.providers.includes(name as SocialProviderName))
        addSetupDiagnostic(
          diagnostics,
          `social.credentials.${name}`,
          'Disabled providers must not carry credential references'
        )
    if (!state.installedPackages.includes('@adonisjs/ally'))
      addSetupDiagnostic(
        diagnostics,
        'social',
        'Install @adonisjs/ally before activating social sign-in',
        'action'
      )
    if (!state.files['config/ally.ts'])
      addSetupDiagnostic(
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
    addSetupDiagnostic(
      diagnostics,
      'social',
      'Enabled socialAuthentication requires selected providers'
    )
}
