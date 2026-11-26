import type { AuthorizationCallbacks } from '../../src/types.ts'

const authorize = (value: boolean): AuthorizationCallbacks => ({
  invite: async () => value,
  manageInvitation: async () => value,
  listInvitations: async () => value,
})
export const allowAll = authorize(true)
export const denyAll = authorize(false)
