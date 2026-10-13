import type { DateTime } from 'luxon'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

export type Trx = TransactionClientContract
export type UserId = number | string

export interface AccountUser {
  id: UserId
  email: string
  hasPassword: boolean
  emailVerifiedAt: DateTime | null
}

/**
 * Adapter obligations:
 * - compare emails case-insensitively and store them trimmed and lowercase
 * - enforce a single-column unique index on the users table's email column;
 *   on PostgreSQL its constraint must be named `users_email_unique` so duplicate
 *   email races are mapped to EmailAlreadyRegisteredError
 * - when `forUpdate` is true, select the user through `trx` with `FOR UPDATE` on PostgreSQL;
 *   SQLite uses a plain select after the package has acquired its write lock
 * - hash passwords in `create` and `setPassword`
 * - run every method that receives `trx` through that transaction
 */
export interface UsersAdapter {
  findByEmail(
    email: string,
    trx?: Trx,
    options?: { forUpdate?: boolean }
  ): Promise<AccountUser | null>
  findById(id: UserId, trx?: Trx, options?: { forUpdate?: boolean }): Promise<AccountUser | null>
  create(
    attrs: { email: string; password: string; emailVerifiedAt: DateTime },
    trx: Trx
  ): Promise<AccountUser>
  setPassword(id: UserId, password: string, trx: Trx): Promise<void>
  setEmail(id: UserId, email: string, trx: Trx): Promise<void>
  markEmailVerified(id: UserId, at: DateTime, trx: Trx): Promise<void>
  verifyPassword(id: UserId, password: string, trx: Trx): Promise<boolean>
}

export interface Invitation {
  id: number
  email: string
  role: string
  inviterId: UserId | null
  expiresAt: DateTime
  createdAt: DateTime
  updatedAt: DateTime
}

export interface AccountKitConfig {
  users: UsersAdapter
  authorize: {
    invite(actor: AccountUser, role: string): Promise<boolean>
    manageInvitation(actor: AccountUser, invitation: Invitation): Promise<boolean>
    listInvitations(actor: AccountUser): Promise<boolean>
  }
  urls: {
    recovery(token: string): string
    verification(token: string): string
    invitation(token: string): string
    emailChange(token: string): string
  }
  notify: {
    recovery(user: AccountUser, url: string): Promise<void>
    verification(user: AccountUser, url: string): Promise<void>
    invitation(invitation: Invitation, url: string): Promise<void>
    emailChangeConfirm(user: AccountUser, newEmail: string, url: string): Promise<void>
    emailChanged(previousEmail: string, user: AccountUser): Promise<void>
  }
  onInvitationAccepted: (user: AccountUser, invitation: Invitation, trx: Trx) => Promise<void>
  onCredentialsChanged?: (user: AccountUser) => Promise<void>
  ttl?: { recovery?: string; verification?: string; invitation?: string; emailChange?: string }
  throttle?: { requests?: number; duration?: string }
  minRequestMs?: number
}

export interface ResolvedConfig extends Required<Omit<AccountKitConfig, 'onCredentialsChanged'>> {
  onCredentialsChanged?: AccountKitConfig['onCredentialsChanged']
  ttl: Required<NonNullable<AccountKitConfig['ttl']>>
  throttle: Required<NonNullable<AccountKitConfig['throttle']>>
}

export interface RecoveryRequestInput {
  email: string
  clientKey: string
}
export interface RecoveryInspectInput {
  token: string
}
export interface RecoveryResetInput {
  token: string
  password: string
}
export interface VerificationSendInput {
  userId: UserId
}
export interface VerificationCompleteInput {
  token: string
}
export interface InvitationsSendInput {
  actorId: UserId
  email: string
  role: string
}
export interface InvitationsListInput {
  actorId: UserId
}
export interface InvitationsInspectInput {
  token: string
}
export interface InvitationsAcceptInput {
  token: string
  password: string
}
export interface InvitationsResendInput {
  actorId: UserId
  invitationId: number
}
export interface InvitationsRevokeInput {
  actorId: UserId
  invitationId: number
}
export interface CredentialsChangePasswordInput {
  actorId: UserId
  currentPassword: string
  newPassword: string
}
export interface CredentialsRequestEmailChangeInput {
  actorId: UserId
  currentPassword: string
  newEmail: string
}
export interface CredentialsCompleteEmailChangeInput {
  token: string
}
