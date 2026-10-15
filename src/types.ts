import type { DateTime } from 'luxon'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

export type Trx = TransactionClientContract
export type UserId = number | string

export interface AccountUser {
  id: UserId
  email: string
  unverifiedEmail: string | null
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
      unverifiedEmail: string | null
      password: string | null
      registrationData?: unknown
    },
    trx: Trx
  ): Promise<AccountUser>
  setPassword(id: UserId, password: string, trx: Trx): Promise<void>
  setEmail(id: UserId, email: string, trx: Trx): Promise<void>
  setUnverifiedEmail(id: UserId, email: string | null, trx: Trx): Promise<void>
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

export type Capability =
  'passwordReset' | 'emailVerification' | 'invitations' | 'emailPasswordManagement' | 'registration'
export type CredentialOperation =
  'password_reset' | 'password_change' | 'email_change' | 'access_restriction' | 'registration_claim'

export interface CredentialChangeContext {
  operation: CredentialOperation
  operationId: string
  userId: UserId
}

export type LifecycleEvent =
  | {
      type:
        | 'registration.created'
        | 'verification.completed'
        | 'password_reset.requested'
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
  passwordReset(token: string): string
  emailVerification(token: string): string
  invitation(token: string): string
  emailChange(token: string): string
}
export interface NotificationCallbacks {
  passwordResetProvision(user: AccountUser, url: string): Promise<void>
  accountActivationProvision(user: AccountUser, url: string): Promise<void>
  invitationProvision(invitation: Invitation, url: string): Promise<void>
  emailChangeProvision(user: AccountUser, newEmail: string, url: string): Promise<void>
  emailChanged(previousEmail: string, user: AccountUser): Promise<void>
  passwordResetCompleted(user: AccountUser, context: CredentialChangeContext): Promise<void>
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
  onPasswordResetIssuedTransaction?: (user: AccountUser, trx: Trx) => Promise<void>
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
  expiresIn?: {
    passwordReset?: string | number
    emailVerification?: string | number
    invitation?: string | number
    emailChange?: string | number
  }
  throttle?: Partial<ThrottleBudget>
  invitationThrottle?: Partial<InvitationThrottle>
  minRequestMs?: number
  tokenSecretLength?: number
  authentication?: AuthenticationConfig
  registration?: {
    availability: 'open' | 'closed' | 'application'
    mapFields?: (input: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>
  }
  passwordPolicy?: Partial<PasswordPolicy>
}

export interface PasswordPolicy {
  minLength: number
  maxLength: number | null
  letters: boolean
  mixedCase: boolean
  numbers: boolean
  symbols: boolean
  minScore: number
}

export interface AuthenticationConfig {
  strategy: 'session' | 'access_tokens'
  guard: string
  /** Return false to deny login and protected access. Called under the account lock. */
  canAccess?: (user: AccountUser, trx: Trx) => Promise<boolean>
  clientLimit?: ThrottleBudget
  identityLimit?: ThrottleBudget & { blockDuration?: string }
  tokenAbilities?: string[]
  tokenExpiresIn?: string | number
  tokenTable?: string
}

export interface ResolvedAuthenticationConfig extends Omit<
  AuthenticationConfig,
  'clientLimit' | 'identityLimit' | 'tokenAbilities' | 'tokenExpiresIn' | 'tokenTable' | 'canAccess'
> {
  clientLimit: ThrottleBudget
  identityLimit: ThrottleBudget & { blockDuration: string }
  tokenAbilities: string[]
  tokenExpiresIn: string | number | null
  tokenTable: string
  canAccess: (user: AccountUser, trx: Trx) => Promise<boolean>
}

export interface PasswordLoginInput {
  email: string
  password: string
  /** Stable, trusted client identity derived after proxy configuration. */
  clientKey: string
}

export interface CurrentAccount {
  id: UserId
  email: string
  unverifiedEmail: string | null
  hasPassword: boolean
  active: boolean
}

export interface CurrentAccountInput {
  userId: UserId
  /** Mandatory for session guards, even when the current database stamp is null. */
  revision?: string | null
  /** Trusted identifier from the authenticated access-token guard. Mandatory for token guards. */
  tokenId?: UserId
}

export type AuthenticationGuard<Credential> =
  | {
      strategy: 'session'
      name: string
      establish(userId: UserId, revision: string | null): Promise<Credential>
      terminate(credential?: Credential): Promise<void>
    }
  | {
      strategy: 'access_tokens'
      name: string
      establish(
        userId: UserId,
        abilities: string[],
        expiresIn: string | number | null
      ): Promise<Credential>
      terminate(credential?: Credential): Promise<void>
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
  | 'expiresIn'
  | 'throttle'
  | 'invitationThrottle'
  | 'minRequestMs'
  | 'authentication'
  | 'passwordPolicy'
> {
  enabled: Capability[]
  authorize: AuthorizationCallbacks
  urls: UrlCallbacks
  notify: NotificationCallbacks
  onInvitationAccepted: NonNullable<AccountKitConfig['onInvitationAccepted']>
  usersTable: string
  limiterNamespace: string
  expiresIn: Required<NonNullable<AccountKitConfig['expiresIn']>>
  throttle: ThrottleBudget
  invitationThrottle: InvitationThrottle
  minRequestMs: number
  tokenSecretLength: number
  authentication?: ResolvedAuthenticationConfig
  passwordPolicy: PasswordPolicy
}

export interface RegistrationInput {
  email: string
  password: string
  registrationData?: unknown
}

export interface InvitationPage {
  items: Invitation[]
  nextCursor: string | null
}

export interface PasswordResetRequestInput {
  email: string
  clientKey: string
}
export interface PasswordResetInspectInput {
  token: string
}
export interface PasswordResetCompleteInput {
  token: string
  password: string
}
export interface VerificationSendInput {
  userId: UserId
}
export interface VerificationCompleteInput {
  token: string
  password: string
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
export interface ChangePasswordInput {
  actorId: UserId
  currentPassword: string
  newPassword: string
}
export interface RequestEmailChangeInput {
  actorId: UserId
  currentPassword: string
  newEmail: string
}
export interface CompleteEmailChangeInput {
  token: string
}
