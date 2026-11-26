/** Parses a managed route's numeric `:id` parameter in canonical positive decimal form as a safe integer. */
import { E_ACCOUNT_KIT_INVALID_INPUT } from '../errors.ts'

export function requirePositiveId(value: string, label: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== value)
    throw new E_ACCOUNT_KIT_INVALID_INPUT(`Invalid ${label} ID`)
  return id
}
