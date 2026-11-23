// Shared output rules for operator commands: one JSON line on stdout, warnings and errors on stderr.
import type { BaseCommand } from '@adonisjs/core/ace'
import { BootstrapApprovalChangedError } from '../src/admission/errors.js'
import { AccountKitError } from '../src/errors.js'
import type { OperatorFault } from '../src/types.js'

export const BEARER_WARNING =
  'The printed link is a bearer secret: anyone holding it can use it until it expires. Share it only over a trusted channel.'

/** Write one machine-readable JSON line to stdout. */
export function writeResult(command: BaseCommand, value: Record<string, unknown>): void {
  command.logger.log(JSON.stringify(value))
}

/** Write a warning to stderr so stdout stays parseable. */
export function writeWarning(command: BaseCommand, message: string): void {
  command.logger.logError(command.logger.prepareWarning(message))
}

const FAILURE_MESSAGES: Record<string, string> = {
  E_ACCOUNT_KIT_ADMISSION_DECISION: 'The current admission record does not allow this operation',
  E_ACCOUNT_KIT_CAPABILITY_DISABLED: 'Check that the required capability is enabled',
  E_ACCOUNT_KIT_DELIVERY: 'The change committed but delivery failed',
  E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED: 'An account already uses that email address',
  E_ACCOUNT_KIT_INVALID_INPUT: 'Check the command arguments and options',
  E_ACCOUNT_KIT_OPERATOR: 'Operator command failed. Check configuration',
  E_ACCOUNT_KIT_POST_COMMIT: 'The change committed but a follow-up failed',
  E_ACCOUNT_KIT_USER_NOT_FOUND: 'No account uses that email address',
}

/** Report an Ace runtime failure once, preserving its error and the command's failure code. */
export function completeOperatorCommand(
  command: BaseCommand & { failure: string | null }
): boolean {
  // Ace sets the exit code even when the thrown value is falsy.
  if (command.exitCode === 0 || command.failure !== null) return false
  const error: unknown = command.error
  const code = error instanceof AccountKitError ? error.code : 'E_ACCOUNT_KIT_OPERATOR'
  const diagnosticCode = Object.hasOwn(FAILURE_MESSAGES, code) ? code : 'E_ACCOUNT_KIT_OPERATOR'
  const message =
    error instanceof BootstrapApprovalChangedError
      ? BootstrapApprovalChangedError.diagnostic
      : FAILURE_MESSAGES[diagnosticCode]
  command.logger.error(`${diagnosticCode}: ${message}`)
  command.failure = code
  return true
}

/** What an operator command that saves a link and then emails or prints it reports. */
export interface OperatorOutcome {
  /** The operator call's result: the printed URL and any follow-up fault. */
  result: { url?: string; fault?: OperatorFault }
  /** Whether the link was printed rather than sent. */
  printed: boolean
  /** The JSON fields written between `result` and `url`. */
  fields: Record<string, unknown>
  /** What was saved, opening the fault message, for example `Invitation`. */
  faultLabel: string
  /** Warnings written after the bearer warning. */
  warnings?: string[]
}

/**
 * Write the warnings and the JSON result line, then report any fault after commit and fail the
 * command. Returns the fault name, or null.
 */
export function reportOperatorOutcome(
  command: BaseCommand,
  outcome: OperatorOutcome
): string | null {
  const { result } = outcome
  if (result.url) writeWarning(command, BEARER_WARNING)
  for (const warning of outcome.warnings ?? []) writeWarning(command, warning)
  writeResult(command, {
    result: outcome.printed ? 'printed' : 'sent',
    ...outcome.fields,
    ...(result.url ? { url: result.url } : {}),
    ...(result.fault ? { fault: result.fault } : {}),
  })
  if (!result.fault) return null
  command.logger.error(
    `${outcome.faultLabel} committed but a follow-up failed: ${result.fault.message}`
  )
  command.exitCode = 1
  return result.fault.name
}
