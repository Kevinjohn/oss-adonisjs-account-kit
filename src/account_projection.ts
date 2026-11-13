import type { AccountUser, CurrentAccount } from './types.js'

/** An account is active unless its only address is still unconfirmed. */
export function isActiveAccount(user: Pick<AccountUser, 'email' | 'unverifiedEmail'>): boolean {
  return user.unverifiedEmail !== user.email
}

/** The account's address is confirmed: verified, and not only waiting for confirmation. */
export function hasConfirmedAddress(user: AccountUser): boolean {
  return user.emailVerifiedAt !== null && isActiveAccount(user)
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
