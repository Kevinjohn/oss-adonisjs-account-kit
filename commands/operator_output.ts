// Shared output rules for operator commands: one JSON line on stdout, warnings and errors on stderr.
import type { BaseCommand } from '@adonisjs/core/ace'
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
  command.logger.logError(`[ warn ] ${message}`)
}

/** Report a failure on stderr without causes, stacks or URLs, and fail the command. */
export function writeFailure(command: BaseCommand, error: unknown): string {
  const code = error instanceof AccountKitError ? error.code : 'E_ACCOUNT_KIT_OPERATOR'
  const message =
    error instanceof AccountKitError
      ? error.message
      : 'Operator command failed; check configuration'
  command.logger.error(`${code}: ${message}`)
  command.exitCode = 1
  return code
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
