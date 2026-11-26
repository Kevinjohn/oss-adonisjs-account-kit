import { RuntimeException } from '@adonisjs/core/exceptions'

/** Validate the application's access decision without exposing its value in a contract fault. */
export function requireAccountAccessDecision(result: unknown): boolean {
  if (typeof result !== 'boolean')
    throw new RuntimeException('account_kit: canAccess must resolve to a boolean')
  return result
}
