// Resolves the admission service for an operator command, or fails the command when the admission
// provider is not registered.
import type { BaseCommand } from '@adonisjs/core/ace'
import { AccountAdmission } from './service.ts'

const ADMISSION_NOT_INSTALLED =
  'Admission is not installed. Run node ace account-kit:admission:install'

/**
 * Returns the container's admission service. Without one, writes one error line, sets exit code 1
 * and returns null, so the command writes nothing to stdout.
 */
export async function operatorAdmission(
  command: BaseCommand & { failure: string | null }
): Promise<AccountAdmission | null> {
  if (command.app.container.hasBinding(AccountAdmission))
    return command.app.container.make(AccountAdmission)
  command.logger.error(ADMISSION_NOT_INSTALLED)
  command.exitCode = 1
  command.failure = 'E_ACCOUNT_KIT_OPERATOR'
  return null
}
