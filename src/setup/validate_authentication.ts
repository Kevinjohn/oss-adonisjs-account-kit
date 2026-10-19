import type { SetupChoices, SetupDiagnostic, SetupInspection } from './types.js'
import { hasEmailFlow, diagnostic } from './shared.js'

/** Guard selection and the session or token checks for the selected strategy. */
export function validateAuthentication(
  diagnostics: SetupDiagnostic[],
  choices: SetupChoices,
  state: SetupInspection,
  production: boolean
) {
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
}
