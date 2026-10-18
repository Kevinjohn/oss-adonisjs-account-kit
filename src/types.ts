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
  | 'magicLinkLogin'
  | 'sessionManagement'
export type CredentialOperation =
  | 'password_reset'
  | 'password_change'
  | 'email_change'
  | 'access_restriction'
  | 'registration_claim'
  | 'social_unlink'
  | 'sign_out_everywhere'

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
        | 'magic_link.requested'
        | 'sessions.revoked_all'
      userId: UserId
      operationId: string
      /** Present only when an operator command, not an account holder, started the operation. */
      source?: 'operator'
    }
  | { type: 'sessions.revoked'; userId: UserId; operationId: string; count: number }
  | {
      type: 'invitation.sent' | 'invitation.resent' | 'invitation.revoked'
      invitationId: number
      operationId: string
      source?: 'operator'
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
  magicLink(token: string): string
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
  magicLinkProvision(user: AccountUser, url: string): Promise<void>
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
    magicLink?: string | number
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
  sessionManagement?: SessionManagementConfig
}

export interface SessionManagementConfig {
  /** A sign-in unused for this long is signed out. Default `30d`; must exceed five minutes. */
  idleExpiry?: string | number
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
  /** Untrusted display text for the sign-in list, such as a User-Agent; at most 255 characters. */
  sessionLabel?: string
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
  /** Session sign-in handle the guard stored at login. Mandatory for session guards with `sessionManagement`. */
  sessionHandle?: string
}

/** One place the user is signed in: a session registry row or an access token. */
export interface SignIn {
  id: number
  label: string | null
  createdAt: string
  lastSeenAt: string | null
  expiresAt: string | null
  current: boolean
}

export type AuthenticationGuard<Credential> =
  | {
      strategy: 'session'
      name: string
      /** `handle` is set when `sessionManagement` is enabled; store it in the session. */
      establish(userId: UserId, revision: string | null, handle?: string): Promise<Credential>
      terminate(credential?: Credential): Promise<void>
    }
  | {
      strategy: 'access_tokens'
      name: string
      establish(
        userId: UserId,
        abilities: string[],
        expiresIn: string | number | null,
        options?: { name?: string }
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
  | 'sessionManagement'
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
  sessionManagement: Required<SessionManagementConfig>
}

export interface RegistrationInput {
  email: string
  password: string
  registrationData?: unknown
}

export type OperatorDelivery = 'send' | 'print'

export interface OperatorInviteInput {
  email: string
  role: string
  /** `send` notifies the invitee; `print` returns the acceptance URL instead. */
  deliver: OperatorDelivery
}

export interface OperatorResetLinkInput {
  email: string
  deliver: OperatorDelivery
}

/** A committed follow-up failure, reduced to safe fields: no cause, stack, or URL. */
export interface OperatorFault {
  name: string
  message: string
}

export interface OperatorInviteResult {
  invitation: Invitation
  url?: string
  fault?: OperatorFault
}

export interface OperatorResetLinkResult {
  user: AccountUser
  url?: string
  fault?: OperatorFault
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
export interface MagicLinkRequestInput {
  email: string
  clientKey: string
  /** Base64url SHA-256 of a verifier the requesting client keeps; 43 characters. */
  clientChallenge: string
}
export interface MagicLinkInspectInput {
  token: string
}
export interface MagicLinkCompleteInput {
  token: string
  /** The verifier whose challenge was sent with the request. */
  verifier: string
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
