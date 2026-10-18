// Shared output rules for operator commands: one JSON line on stdout, warnings and errors on stderr.
import type { BaseCommand } from '@adonisjs/core/ace'
import { AccountKitError } from '../src/errors.js'

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
