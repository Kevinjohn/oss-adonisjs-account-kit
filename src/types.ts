import type { DateTime } from 'luxon'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { socialProviderNames } from './social_providers.js'
import type { sensitivePurposes, socialIntents } from './social_enums.js'

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
  updateRegistrationData?(id: UserId, data: Record<string, unknown>, trx: Trx): Promise<void>
  markEmailVerified(id: UserId, at: DateTime, trx: Trx): Promise<void>
  verifyPassword(id: UserId, password: string, trx: Trx): Promise<boolean>
  /** Required by `accountDeletion`. Delete the user row through trx; model hooks may run. */
  delete?(id: UserId, trx: Trx): Promise<void>
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
  | 'passwordReset'
  | 'emailVerification'
  | 'invitations'
  | 'emailPasswordManagement'
  | 'registration'
  | 'socialAuthentication'
  | 'dataExport'
  | 'accountDeletion'
export type CredentialOperation =
  | 'password_reset'
  | 'password_change'
  | 'email_change'
  | 'access_restriction'
  | 'registration_claim'
  | 'social_unlink'

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
        | 'account.deleted'
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
  socialIdentityLinked(user: AccountUser, identity: SocialIdentity): Promise<void>
  socialIdentityUnlinked(user: AccountUser, identity: SocialIdentity): Promise<void>
  /** Sent after commit to the address the deleted account had. */
  accountDeleted(account: DeletedAccount): Promise<void>
}

/** What remains of a deleted account: enough to address the confirmation email. */
export interface DeletedAccount {
  id: UserId
  email: string
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
  /** Application-owned delivery guarantee; durable requires an application queue or outbox. */
  delivery?: 'best-effort' | 'durable' | 'capture'
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
  registration: {
    availability: 'open' | 'closed' | 'application'
    mapFields?: (input: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>
  }
  passwordPolicy?: Partial<PasswordPolicy>
  socialAuthentication?: SocialAuthenticationConfig
  /**
   * Application data for the account export. Runs inside the export transaction; return a
   * JSON-serialisable value. Its result becomes the export's `application` section.
   */
  exportAccountData?: (user: AccountUser, trx: Trx) => Promise<unknown>
  /**
   * Delete or anonymise application rows before the user row is deleted. Use only trx and no
   * remote side effects: it may run again when SQLite retries a busy transaction. Throwing
   * aborts the deletion.
   */
  onAccountDeletingTransaction?: (user: AccountUser, trx: Trx) => Promise<void>
  accountDeletion?: AccountDeletionConfig
}

export interface AccountDeletionConfig {
  /** Invitations the user sent: `revoke` (default) deletes them, `keep` leaves them acceptable. */
  invitations?: 'keep' | 'revoke'
}

export interface PasswordPolicy {
  minLength: number
  maxLength: number | null
  letters: boolean
  mixedCase: boolean
  numbers: boolean
  symbols: boolean
  minScore: 0 | 1 | 2 | 3 | 4
}

export type SocialProviderName = (typeof socialProviderNames)[number]
export type SocialIntent = (typeof socialIntents)[number]
export type SensitivePurpose = (typeof sensitivePurposes)[number]

/** Returned only after the configured adapter verifies provider authentication evidence. */
export interface VerifiedSocialAuthentication {
  verified: true
  subject: string
  /** Provider-attested authentication time as an ISO 8601 UTC timestamp. */
  authenticatedAt: string
}

/** The application uses Ally at this boundary. Provider credentials never reach Account Kit. */
export interface SocialProvider {
  authorizationUrl(state: string, context?: unknown): Promise<string>
  resolve(callback: unknown): Promise<{
    subject: string
    email: string | null
    emailVerified: boolean
    name?: string | null
    nickname?: string | null
    avatarUrl?: string | null
  }>
  /** Omit when this provider cannot attest a fresh authentication event. */
  verifyFreshAuthentication?(
    callback: unknown,
    expected: { state: string; subject: string }
  ): Promise<VerifiedSocialAuthentication | null>
}

export interface SocialAuthenticationConfig {
  providers: Partial<Record<SocialProviderName, SocialProvider>>
}

export interface SocialIdentity {
  id: number
  userId: UserId
  provider: SocialProviderName
  providerUserId: string
  email: string | null
  emailVerified: boolean
}

export interface SocialBeginInput {
  provider: SocialProviderName
  intent: Exclude<SocialIntent, 'confirm'>
  current?: CurrentAccountInput
  purpose?: SensitivePurpose
  /** SHA-256 base64url challenge of a verifier held by the initiating client. */
  clientChallenge: string
  /** Opaque request context for a request-scoped provider adapter. */
  context?: unknown
  /** Recent social_link proof kept in the server transaction, never in the provider URL. */
  proof?: string
}

export interface SocialCallbackInput {
  state: string
  /** The route provider, when the caller has a provider-specific callback URL. */
  provider?: SocialProviderName
  callback: unknown
  intent?: SocialIntent
  current?: CurrentAccountInput
  proof?: string
  verificationToken?: string
}

export type SocialCallbackResult =
  | { status: 'linked' | 'new'; userId: UserId; handoffCode?: string }
  | { status: 'new'; continuation: string }
  | { status: 'new'; emailVerificationRequired: true }
  | { status: 'link_required' }
  | { status: 'reauthenticated'; proof: string }

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
  | 'delivery'
  | 'onInvitationAccepted'
  | 'usersTable'
  | 'limiterNamespace'
  | 'expiresIn'
  | 'throttle'
  | 'invitationThrottle'
  | 'minRequestMs'
  | 'authentication'
  | 'passwordPolicy'
  | 'accountDeletion'
> {
  enabled: Capability[]
  authorize: AuthorizationCallbacks
  urls: UrlCallbacks
  notify: NotificationCallbacks
  delivery: 'best-effort' | 'durable' | 'capture'
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
  accountDeletion: Required<AccountDeletionConfig>
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
export interface VerificationInspectInput {
  token: string
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
  currentPassword?: string
  /** Purpose-bound proof issued by a fresh provider reauthentication for social-only accounts. */
  recentProof?: string
  newPassword: string
}
export interface RequestEmailChangeInput {
  actorId: UserId
  currentPassword?: string
  recentProof?: string
  newEmail: string
}
export interface UpdateProfileInput {
  actorId: UserId
  currentPassword?: string
  recentProof?: string
  email?: string
  registrationData?: unknown
}
export interface CompleteEmailChangeInput {
  token: string
}
export interface InspectEmailChangeInput {
  token: string
}

/** Fresh re-authentication for export and deletion, as for a password change. */
export interface AccountDataInput {
  actorId: UserId
  currentPassword?: string
  /** Purpose-bound proof (`account_export` or `account_delete`) for password-less accounts. */
  recentProof?: string
}

/** Version 1 of the account export document. Timestamps are ISO 8601 UTC strings. */
export interface AccountExport {
  format: 'adonisjs-account-kit/export'
  version: 1
  generatedAt: string
  account: {
    id: UserId
    email: string
    unverifiedEmail: string | null
    emailVerifiedAt: string | null
    hasPassword: boolean
    credentialsChangedAt: string | null
  }
  socialIdentities: Array<{
    provider: string
    providerUserId: string
    email: string | null
    emailVerified: boolean
    name: string | null
    nickname: string | null
    avatarUrl: string | null
    confirmedAt: string | null
    createdAt: string
  }>
  invitationsSent: Array<{ email: string; role: string; createdAt: string; expiresAt: string }>
  /** Present only for the access-token strategy. */
  accessTokens?: Array<{
    id: number | string
    name: string | null
    createdAt: string | null
    lastUsedAt: string | null
    expiresAt: string | null
  }>
  pending: { passwordReset: boolean; emailVerification: boolean; emailChange: string | null }
  application: unknown
}
