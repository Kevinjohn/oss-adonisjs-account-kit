// Setup planning phase: Mail mailer selection diagnostics for email flows.
import type { SetupChoices, SetupInspection, SetupDiagnostic } from './types.js'
import { hasEmailFlow, diagnostic } from './shared.js'
import { mailerSelectionState } from './config_inspection.js'

export async function planMail(
  choices: SetupChoices,
  state: SetupInspection,
  diagnostics: SetupDiagnostic[]
): Promise<void> {
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
        'Selected Mail mailer must be a callable transport provider'
      )
    else if (selection === 'unsafe')
      diagnostic(
        diagnostics,
        'config/mail.ts',
        'Resolve runtime Mail and environment module provenance before setup'
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
}
