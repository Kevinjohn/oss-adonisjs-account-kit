/** Validate the application policy result without exposing its value in a contract fault. */
export function validateAccountAccessResult(result: unknown): boolean {
  if (typeof result !== 'boolean')
    throw new Error('account_kit: canAccess must resolve to a boolean')
  return result
}
