// The opaque invitation scope: validation, its stored form and the order invitations apply in.
import { E_ACCOUNT_KIT_INVALID_INPUT } from './errors.ts'
import { invitationScopeLength } from './invitation_input.ts'

/** Omitted and null values resolve to unscoped; supplied scope text is opaque. */
export function normalizeScope(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (
    typeof value !== 'string' ||
    value.length < invitationScopeLength.minLength ||
    value.length > invitationScopeLength.maxLength
  )
    throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid scope')
  return value
}

/** The column value: unscoped invitations store `''` so `(email, scope)` stays unique. */
export function encodeScopeColumn(scope: string | null): string {
  return scope ?? ''
}

/** The scope an `account_invitations` row carries, `''` meaning unscoped. */
export function decodeScopeColumn(value: string): string | null {
  return value === '' ? null : value
}

/** Ascending scope order (code units), unscoped first; stable for equal scopes. */
export function compareScopes<Row extends { scope: string }>(a: Row, b: Row): number {
  if (a.scope < b.scope) return -1
  return a.scope > b.scope ? 1 : 0
}
