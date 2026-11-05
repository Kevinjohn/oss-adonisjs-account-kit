// The opaque invitation scope: validation, its stored form and the order invitations apply in.
import { InvalidInputError } from './errors.js'

const MAX_SCOPE_LENGTH = 255

/** `null` for an unscoped invitation; otherwise a 1 to 255 character string. */
export function normalizeScope(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_SCOPE_LENGTH)
    throw new InvalidInputError('Invalid scope')
  return value
}

/** The column value: unscoped invitations store `''` so `(email, scope)` stays unique. */
export function scopeColumn(scope: string | null): string {
  return scope ?? ''
}

/** The scope an `account_invitations` row carries, `''` meaning unscoped. */
export function scopeFromColumn(value: string): string | null {
  return value === '' ? null : value
}

/** Ascending scope order (code units), unscoped first; stable for equal scopes. */
export function byScope<Row extends { scope: string }>(a: Row, b: Row): number {
  if (a.scope < b.scope) return -1
  return a.scope > b.scope ? 1 : 0
}
