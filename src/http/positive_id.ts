/** Parses a managed route's numeric `:id` parameter as a positive safe integer. */
import { InvalidInputError } from '../errors.js'

export function positiveId(value: string, label: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new InvalidInputError(`Invalid ${label} ID`)
  return id
}
