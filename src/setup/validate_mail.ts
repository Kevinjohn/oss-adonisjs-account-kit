import {
  mailDeliveries,
  mailIntegrations,
  type SetupChoices,
  type SetupDiagnostic,
  type SetupFeature,
  type SetupInspection,
} from './types.js'
import { createActionUrls } from '../notifications.js'
import {
  emailDestinations,
  hasEmailFlow,
  envName,
  addSetupDiagnostic,
  addOriginDiagnostics,
} from './shared.js'
import type { SelectedSetupOrigins } from './diagnostics.js'

/** Mail integration, environment references, destinations and origins for email flows. */
export function addMailDiagnostics(
  diagnostics: SetupDiagnostic[],
  choices: SetupChoices,
  state: SetupInspection,
  production: boolean,
  env: NodeJS.ProcessEnv,
  selectedOrigins?: SelectedSetupOrigins
) {
  const emailEnabled = hasEmailFlow(choices)
  if (emailEnabled && !mailIntegrations.includes(choices.mail.integration))
    addSetupDiagnostic(diagnostics, 'mail.integration', 'Choose adonisjs-mail or custom')
  if (emailEnabled && !mailDeliveries.includes(choices.mail.delivery))
    addSetupDiagnostic(diagnostics, 'mail.delivery', 'Choose best-effort or durable')
  for (const field of ['senderEnv', 'transportEnv'] as const) {
    const name = choices.mail[field]
    if (emailEnabled && name && !envName.test(name))
      addSetupDiagnostic(
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
    addSetupDiagnostic(
      diagnostics,
      'config/mail.ts',
      'Configure AdonisJS Mail with a real transport before applying'
    )
  if (
    emailEnabled &&
    choices.mail.integration === 'custom' &&
    !state.files['app/services/account_kit_notifications.ts']
  )
    addSetupDiagnostic(
      diagnostics,
      'mail.integration',
      'Provide #services/account_kit_notifications before activation'
    )
  else if (emailEnabled && choices.mail.integration === 'custom')
    addSetupDiagnostic(
      diagnostics,
      'mail.callbacks',
      'Verify the application-owned notification callbacks for every selected email flow and a real delivery transport',
      'action'
    )
  if (emailEnabled && (!choices.mail.appName.trim() || /[\r\n]/.test(choices.mail.appName)))
    addSetupDiagnostic(diagnostics, 'mail.appName', 'Application identity is required')
  if (emailEnabled && choices.mail.integration === 'adonisjs-mail' && !choices.mail.senderEnv)
    addSetupDiagnostic(diagnostics, 'mail.senderEnv', 'Sender environment reference is required')
  if (emailEnabled && choices.mail.integration === 'adonisjs-mail' && !choices.mail.transportEnv)
    addSetupDiagnostic(
      diagnostics,
      'mail.transportEnv',
      'Transport environment reference is required'
    )
  if (emailEnabled && choices.mail.integration === 'adonisjs-mail') {
    for (const field of ['senderEnv', 'transportEnv'] as const) {
      const name = choices.mail[field]
      if (!name || !envName.test(name)) continue
      const error = selectedOrigins?.errors[name]
      if (error) {
        addSetupDiagnostic(diagnostics, `mail.${field}`, `${name}: ${error.message}`)
        continue
      }
      const value =
        selectedOrigins && Object.hasOwn(selectedOrigins.values, name)
          ? (selectedOrigins.values[name] ?? undefined)
          : env[name]
      if (value === undefined || value === '')
        addSetupDiagnostic(
          diagnostics,
          `mail.${field}`,
          `${name} must be set before readiness can pass`,
          'action'
        )
      else if (!value.trim() || (field === 'senderEnv' && /[\r\n]/.test(value)))
        addSetupDiagnostic(
          diagnostics,
          `mail.${field}`,
          'Configured value must be nonblank and safe'
        )
    }
  }
  for (const [feature, destination] of Object.entries(emailDestinations)) {
    if (
      emailEnabled &&
      choices.features.includes(feature as SetupFeature) &&
      !choices.mail.destinations[destination!]
    )
      addSetupDiagnostic(
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
      addSetupDiagnostic(
        diagnostics,
        `mail.destinations.${field}`,
        'Use a safe relative frontend path without whitespace, traversal, query or fragment'
      )
    }
  }
  if (emailEnabled) {
    addOriginDiagnostics(diagnostics, 'mail.backendOriginEnv', choices.mail.backendOriginEnv, {
      production,
      env,
      resolvedValue: selectedOrigins?.values[choices.mail.backendOriginEnv],
      resolutionError: selectedOrigins?.errors[choices.mail.backendOriginEnv],
    })
    addOriginDiagnostics(diagnostics, 'mail.frontendOriginEnv', choices.mail.frontendOriginEnv, {
      production,
      env,
      resolvedValue: selectedOrigins?.values[choices.mail.frontendOriginEnv],
      resolutionError: selectedOrigins?.errors[choices.mail.frontendOriginEnv],
    })
  }
  if (emailEnabled && choices.mail.delivery === 'durable' && !choices.mail.durableWorkerVerified)
    addSetupDiagnostic(
      diagnostics,
      'mail.durableWorkerVerified',
      'Verify application-owned queue/outbox worker and retry before durable readiness'
    )
  if (emailEnabled && choices.mail.delivery === 'durable' && choices.mail.integration !== 'custom')
    addSetupDiagnostic(
      diagnostics,
      'mail.delivery',
      'Durable delivery requires application-owned notification callbacks backed by a verified queue or outbox'
    )
}
