// Setup planning phase: Mail mailer selection diagnostics for email flows.
import type { SetupChoices, SetupInspection, SetupDiagnostic } from './types.js'
import { hasEmailFlow, addSetupDiagnostic } from './shared.js'
import { classifyMailerSelection } from './config_inspection.js'

export async function planMail(
  choices: SetupChoices,
  state: SetupInspection,
  diagnostics: SetupDiagnostic[],
  env?: NodeJS.ProcessEnv
): Promise<void> {
  if (
    hasEmailFlow(choices) &&
    choices.mail.integration === 'adonisjs-mail' &&
    state.files['config/mail.ts']
  ) {
    const selection = await classifyMailerSelection(
      state.files['config/mail.ts'],
      state.root,
      choices.mail.transportEnv,
      env
    )
    if (selection === 'missing')
      addSetupDiagnostic(
        diagnostics,
        'config/mail.ts',
        'Selected Mail mailer is absent from the configured mailers map'
      )
    else if (selection === 'invalid')
      addSetupDiagnostic(
        diagnostics,
        'config/mail.ts',
        'Selected Mail mailer must be a callable transport provider'
      )
    else if (selection === 'unsafe')
      addSetupDiagnostic(
        diagnostics,
        'config/mail.ts',
        'Resolve runtime Mail and environment module origins before setup'
      )
    else
      addSetupDiagnostic(
        diagnostics,
        'config/mail.ts',
        selection === 'unresolved'
          ? 'Confirm the selected Mail mailer and its transport configuration manually before readiness'
          : 'Verify the selected Mail transport delivers messages with the deployed configuration before readiness',
        'action'
      )
  }
}
