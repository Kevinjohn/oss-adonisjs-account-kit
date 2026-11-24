import { E_ACCOUNT_KIT_ADAPTER_CONTRACT } from './errors.js'

/** Validate the application's access decision without exposing its value in a contract fault. */
export function requireAccountAccessDecision(result: unknown): boolean {
  if (typeof result !== 'boolean')
    throw new E_ACCOUNT_KIT_ADAPTER_CONTRACT('account_kit: canAccess must resolve to a boolean')
  return result
}
