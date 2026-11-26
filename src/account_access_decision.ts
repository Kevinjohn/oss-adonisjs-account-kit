import { E_ACCOUNT_KIT_INVALID_ACCESS_DECISION } from './errors.ts'

/** Validate the application's access decision without exposing its value in a contract fault. */
export function requireAccountAccessDecision(result: unknown): boolean {
  if (typeof result !== 'boolean') throw new E_ACCOUNT_KIT_INVALID_ACCESS_DECISION()
  return result
}
