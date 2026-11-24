export const invitationRoleLength = { minLength: 1, maxLength: 64 } as const
export const invitationScopeLength = { minLength: 1, maxLength: 255 } as const
export const invitationPageSize = { minimum: 1, maximum: 100, default: 25 } as const

/** Direct callers supply opaque role text. Managed HTTP trims it before validation. */
export function isInvitationRole(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= invitationRoleLength.minLength &&
    value.length <= invitationRoleLength.maxLength
  )
}
