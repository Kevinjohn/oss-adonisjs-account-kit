import type { SetupChoices, SetupDiagnostic, SetupFeature, SetupInspection } from './types.js'
import { createActionUrls } from '../notifications.js'
import { emailDestinations, hasEmailFlow, envName, diagnostic, validateOrigin } from './shared.js'

/** Mail integration, environment references, destinations and origins for email flows. */
export function validateMail(
  diagnostics: SetupDiagnostic[],
  choices: SetupChoices,
  state: SetupInspection,
  production: boolean
) {
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
}
