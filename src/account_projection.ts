import type { AccountUser, CurrentAccount } from './types.js'

/** An account is active unless its only address is still unconfirmed. */
export function isActiveAccount(user: AccountUser): boolean {
  return user.unverifiedEmail !== user.email
}

export function safeAccount(user: AccountUser): CurrentAccount {
  return {
    id: user.id,
    email: user.email,
    unverifiedEmail: user.unverifiedEmail,
    hasPassword: user.hasPassword,
    active: isActiveAccount(user),
  }
}
