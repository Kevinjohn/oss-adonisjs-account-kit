/** Parses a managed route's numeric `:id` parameter in canonical positive decimal form as a safe integer. */
import { InvalidInputError } from '../errors.js'

export function positiveId(value: string, label: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== value)
    throw new InvalidInputError(`Invalid ${label} ID`)
  return id
}
