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

export interface UsersAdapterMetadata {
  table: string
  primaryKey: 'id'
  emailConstraint?: string
}

export interface AuthorizationContext {
  trx?: Trx
}

/**
 * Custom adapters normalize stored email and enforce a single-column unique email index.
 * Configure physical table/constraint metadata, use the default connection, hash passwords,
 * and run every method receiving trx through that transaction. The package owns physical
 * row locks; legacy forUpdate arguments remain additive compatibility parameters.
 * The maintained Lucid adapter derives metadata and preserves model save hooks.
 */
export interface UsersAdapter {
  resolveMetadata?(): Promise<UsersAdapterMetadata>
  findByEmail(
    email: string,
    trx?: Trx,
    options?: { forUpdate?: boolean }
  ): Promise<AccountUser | null>
  findById(id: UserId, trx?: Trx, options?: { forUpdate?: boolean }): Promise<AccountUser | null>
  create(
    attrs: {
      email: string
      password: string
      emailVerifiedAt: DateTime
      registrationData?: unknown
    },
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

export type Capability = 'recovery' | 'verification' | 'invitations' | 'credentials'
export type CredentialOperation = 'password_reset' | 'password_change' | 'email_change'

export interface CredentialChangeContext {
  operation: CredentialOperation
  operationId: string
  userId: UserId
}

export type LifecycleEvent =
  | {
      type:
        | 'verification.completed'
        | 'recovery.requested'
        | 'password.reset'
        | 'password.changed'
        | 'email_change.requested'
        | 'email_change.completed'
      userId: UserId
      operationId: string
    }
  | {
      type: 'invitation.sent' | 'invitation.resent' | 'invitation.revoked'
      invitationId: number
      operationId: string
    }
  | { type: 'invitation.accepted'; invitationId: number; userId: UserId; operationId: string }

export interface AuthorizationCallbacks {
  invite(actor: AccountUser, role: string, context?: AuthorizationContext): Promise<boolean>
  manageInvitation(
    actor: AccountUser,
    invitation: Invitation,
    context?: AuthorizationContext
  ): Promise<boolean>
  listInvitations(actor: AccountUser, context?: AuthorizationContext): Promise<boolean>
}
export interface UrlCallbacks {
  recovery(token: string): string
  verification(token: string): string
  invitation(token: string): string
  emailChange(token: string): string
}
export interface NotificationCallbacks {
  recovery(user: AccountUser, url: string): Promise<void>
  verification(user: AccountUser, url: string): Promise<void>
  invitation(invitation: Invitation, url: string): Promise<void>
  emailChangeConfirm(user: AccountUser, newEmail: string, url: string): Promise<void>
  emailChanged(previousEmail: string, user: AccountUser): Promise<void>
  passwordReset(user: AccountUser, context: CredentialChangeContext): Promise<void>
  passwordChanged(user: AccountUser, context: CredentialChangeContext): Promise<void>
}
export interface ThrottleBudget {
  requests: number
  duration: string
}
export interface InvitationThrottle {
  sendActor: ThrottleBudget
  sendRecipient: ThrottleBudget
  resendActor: ThrottleBudget
  resendInvitation: ThrottleBudget
}

export interface AccountKitConfig {
  users: UsersAdapter
  enabled?: Capability[]
  authorize?: Partial<AuthorizationCallbacks>
  urls: Partial<UrlCallbacks>
  notify: Partial<NotificationCallbacks>
  onInvitationAccepted?: (user: AccountUser, invitation: Invitation, trx: Trx) => Promise<void>
  onCredentialsChanged?: (user: AccountUser, context: CredentialChangeContext) => Promise<void>
  onCredentialsChangedTransaction?: (
    user: AccountUser,
    context: CredentialChangeContext,
    trx: Trx
  ) => Promise<void>
  onLifecycleEvent?: (event: LifecycleEvent) => Promise<void>
  usersTable?: string
  emailConstraint?: string
  limiterSecret: string
  limiterNamespace?: string
  ttl?: { recovery?: string; verification?: string; invitation?: string; emailChange?: string }
  throttle?: Partial<ThrottleBudget>
  invitationThrottle?: Partial<InvitationThrottle>
  minRequestMs?: number
}

export interface ResolvedConfig extends Omit<
  AccountKitConfig,
  | 'enabled'
  | 'authorize'
  | 'urls'
  | 'notify'
  | 'onInvitationAccepted'
  | 'usersTable'
  | 'limiterNamespace'
  | 'ttl'
  | 'throttle'
  | 'invitationThrottle'
  | 'minRequestMs'
> {
  enabled: Capability[]
  authorize: AuthorizationCallbacks
  urls: UrlCallbacks
  notify: NotificationCallbacks
  onInvitationAccepted: NonNullable<AccountKitConfig['onInvitationAccepted']>
  usersTable: string
  limiterNamespace: string
  ttl: Required<NonNullable<AccountKitConfig['ttl']>>
  throttle: ThrottleBudget
  invitationThrottle: InvitationThrottle
  minRequestMs: number
}

export interface InvitationPage {
  items: Invitation[]
  nextCursor: string | null
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
  limit?: number
  cursor?: string
}
export interface InvitationsInspectInput {
  token: string
}
export interface InvitationsAcceptInput {
  token: string
  password: string
  registrationData?: unknown
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
