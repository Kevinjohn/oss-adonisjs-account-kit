/** Validate the application policy result without exposing its value in a contract fault. */
export function requireAccountAccessDecision(result: unknown): boolean {
  if (typeof result !== 'boolean')
    throw new AdapterContractError('account_kit: canAccess must resolve to a boolean')
  return result
}
import { AdapterContractError } from './errors.js'
