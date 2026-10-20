import type { DateTime } from 'luxon'
import type { Secret } from '@adonisjs/core/helpers'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { socialProviderNames } from './social_providers.js'
import type { sensitivePurposes, socialIntents } from './social_enums.js'

/**
 * A Lucid transaction. Account Kit passes it to every callback that runs inside an account
 * operation; do all database writes in that callback through it.
 */
export type Trx = TransactionClientContract
/** A user's primary key: an integer, string or UUID. */
export type UserId = number | string

/** The account fields Account Kit reads from your users table. */
export interface AccountUser {
  /** The user's primary key. */
  id: UserId
  /** The confirmed address, stored trimmed and lowercase. */
  email: string
  /** An address waiting for confirmation, or null. */
  unverifiedEmail: string | null
  /** False for an account that signs in only through a social provider. */
  hasPassword: boolean
  /** When the address was confirmed; null for an account that has not confirmed it. */
  emailVerifiedAt: DateTime | null
}

/**
 * Where the users live: the physical table, the `id` primary key and, optionally, the unique email
 * constraint name.
 */
export interface UsersAdapterMetadata {
  /** The physical users table. */
  table: string
  /** Always `id`. */
  primaryKey: 'id'
  /** The unique email constraint name, when it is not the default. */
  emailConstraint?: string
}

/**
 * Passed to `authorize` callbacks. `trx` is set when the check runs inside an account transaction;
 * read permission state through it.
 */
export interface AuthorizationContext {
  /** The account transaction, when the check runs inside one. */
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
  /**
   * Returns the table and constraint metadata. Omit it to use `usersTable` and `emailConstraint`
   * from the config.
   */
  resolveMetadata?(): Promise<UsersAdapterMetadata>
  /** Finds a user by normalized email, or returns null. */
  findByEmail(
    email: string,
    trx?: Trx,
    options?: { forUpdate?: boolean }
  ): Promise<AccountUser | null>
  /** Finds a user by id, or returns null. */
  findById(id: UserId, trx?: Trx, options?: { forUpdate?: boolean }): Promise<AccountUser | null>
  /**
   * Creates a user through `trx` and returns it. `registrationData` is untrusted input for your own
   * mapping.
   */
  create(
    attrs: {
      email: string
      unverifiedEmail: string | null
      /** The plain password to hash, or null. Null whenever `passwordHash` is set. */
      password: string | null
      /** A hash from `hashPassword`, to store as is. Only passed when `hashPassword` exists. */
      passwordHash?: string
      registrationData?: unknown
    },
    trx: Trx
  ): Promise<AccountUser>
  /** Hashes and stores a new password through `trx`. */
  setPassword(id: UserId, password: string, trx: Trx): Promise<void>
  /**
   * Hashes a password outside any transaction. When present, Account Kit hashes every new
   * password before it opens the write transaction and passes the result to `create` as
   * `passwordHash` or to `setPasswordHash`, so a slow hash never holds the transaction open.
   * Requires `setPasswordHash`.
   */
  hashPassword?(password: string): Promise<string>
  /** Stores a hash from `hashPassword` as is, through `trx`. Required with `hashPassword`. */
  setPasswordHash?(id: UserId, hash: string, trx: Trx): Promise<void>
  /** Stores a confirmed email address through `trx`. */
  setEmail(id: UserId, email: string, trx: Trx): Promise<void>
  /** Stores or clears the address waiting for confirmation, through `trx`. */
  setUnverifiedEmail(id: UserId, email: string | null, trx: Trx): Promise<void>
  /** Applies trusted profile fields through `trx`. Needed for profile updates with extra fields. */
  updateRegistrationData?(id: UserId, data: Record<string, unknown>, trx: Trx): Promise<void>
  /** Records when the address was confirmed, through `trx`. */
  markEmailVerified(id: UserId, at: DateTime, trx: Trx): Promise<void>
  /** Returns whether the password matches the stored hash. */
  verifyPassword(id: UserId, password: string, trx: Trx): Promise<boolean>
  /** Required by `accountDeletion`. Delete the user row through trx; model hooks may run. */
  delete?(id: UserId, trx: Trx): Promise<void>
}

/** A pending invitation. `role` is an opaque string your `onInvitationAccepted` callback applies. */
export interface Invitation {
  /** The invitation's id, for `resend` and `revoke`. */
  id: number
  /** The invited address, normalized. */
  email: string
  /**
   * The role to grant on acceptance. Account Kit stores it; your `onInvitationAccepted` applies it.
   */
  role: string
  /** Who sent it, or null for an operator invitation or a deleted inviter. */
  inviterId: UserId | null
  /** When the link stops working. */
  expiresAt: DateTime
  createdAt: DateTime
  updatedAt: DateTime
}

/**
 * A feature you can turn on in `enabled`. Operations for a capability that is not enabled throw
 * `CapabilityDisabledError`.
 */
export type Capability =
  | 'passwordReset'
  | 'emailVerification'
  | 'invitations'
  | 'emailPasswordManagement'
  | 'registration'
  | 'socialAuthentication'
  | 'magicLinkLogin'
  | 'sessionManagement'
  | 'dataExport'
  | 'accountDeletion'
/** The kind of credential change that ended older sessions and tokens. */
export type CredentialOperation =
  | 'password_reset'
  | 'password_change'
  | 'email_change'
  | 'access_restriction'
  | 'registration_claim'
  | 'social_unlink'
  | 'sign_out_everywhere'

/**
 * Describes a credential change: what happened, a unique id for the operation, and whose account it
 * was.
 */
export interface CredentialChangeContext {
  /** What changed the credentials. */
  operation: CredentialOperation
  /** A unique id for this change, for idempotent workers and audit logs. */
  operationId: string
  /** Whose credentials changed. */
  userId: UserId
}

/**
 * An account event passed to `onLifecycleEvent` after commit, for audit logs and analytics. Carries
 * ids only, never tokens or addresses.
 */
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
        | 'account.deleted'
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

/** Your rules for invitations. Each callback must return exactly `true` to allow. */
export interface AuthorizationCallbacks {
  /** Whether `actor` may invite someone with `role`. */
  invite(actor: AccountUser, role: string, context?: AuthorizationContext): Promise<boolean>
  /** Whether `actor` may resend or revoke this invitation. */
  manageInvitation(
    actor: AccountUser,
    invitation: Invitation,
    context?: AuthorizationContext
  ): Promise<boolean>
  /** Whether `actor` may list invitations. */
  listInvitations(actor: AccountUser, context?: AuthorizationContext): Promise<boolean>
}
/**
 * Build the links that go in emails. Each receives the proof token and returns an absolute URL,
 * normally to a page on your frontend.
 */
export interface UrlCallbacks {
  /** The reset-password page. */
  passwordReset(token: string): string
  /** The confirm-email page. */
  emailVerification(token: string): string
  /** The accept-invitation page. */
  invitation(token: string): string
  /** The confirm-new-email page. */
  emailChange(token: string): string
  /** The magic-link sign-in page. */
  magicLink(token: string): string
}
/**
 * Send account emails. Provision callbacks receive a link to deliver; notice callbacks tell the
 * user something changed. `createMailNotifications` implements all of them with AdonisJS Mail.
 */
export interface NotificationCallbacks {
  /** Send the reset link. */
  passwordResetProvision(user: AccountUser, url: string): Promise<void>
  /** Send the link that confirms a new account's address. */
  accountActivationProvision(user: AccountUser, url: string): Promise<void>
  /** Send the invitation link. */
  invitationProvision(invitation: Invitation, url: string): Promise<void>
  /** Send the confirmation link to the new address. */
  emailChangeProvision(user: AccountUser, newEmail: string, url: string): Promise<void>
  /** Tell the previous address that the email changed. */
  emailChanged(previousEmail: string, user: AccountUser): Promise<void>
  /** Tell the user their password was reset. */
  passwordResetCompleted(user: AccountUser, context: CredentialChangeContext): Promise<void>
  /** Tell the user their password was changed. */
  passwordChanged(user: AccountUser, context: CredentialChangeContext): Promise<void>
  /** Tell the user a provider was linked. Sent only to a confirmed address. */
  socialIdentityLinked(user: AccountUser, identity: SocialIdentity): Promise<void>
  /** Tell the user a provider was unlinked. Sent only to a confirmed address. */
  socialIdentityUnlinked(user: AccountUser, identity: SocialIdentity): Promise<void>
  /** Send the magic sign-in link. */
  magicLinkProvision(user: AccountUser, url: string): Promise<void>
  /** Sent after commit to the address the deleted account had. */
  accountDeleted(account: DeletedAccount): Promise<void>
}

/** What remains of a deleted account: enough to address the confirmation email. */
export interface DeletedAccount {
  id: UserId
  email: string
}
/** A rate limit: `requests` allowed per `duration`, such as `'15m'`. */
export interface ThrottleBudget {
  /** Requests allowed in each window. */
  requests: number
  /** The window, as a duration string such as `'15m'`. */
  duration: string
}
/**
 * Invitation rate limits. Defaults: 10 sends per actor and 3 per recipient per hour, 10 resends per
 * actor and 3 per invitation per hour.
 */
export interface InvitationThrottle {
  /** Invitations one person may send. Default 10 per hour. */
  sendActor: ThrottleBudget
  /** Invitations one address may receive. Default 3 per hour. */
  sendRecipient: ThrottleBudget
  /** Resends one person may make. Default 10 per hour. */
  resendActor: ThrottleBudget
  /** Resends of one invitation. Default 3 per hour. */
  resendInvitation: ThrottleBudget
}

/** The configuration passed to `defineConfig` in `config/account_kit.ts`. */
export interface AccountKitConfig {
  /** Reads and writes your users. Use `createLucidAdapter` for a Lucid model. */
  users: UsersAdapter
  /**
   * The capabilities to turn on. Defaults to `passwordReset`, `emailVerification` and
   * `emailPasswordManagement`.
   */
  enabled?: Capability[]
  /** Your invitation rules. Without them every invitation action is denied. */
  authorize?: Partial<AuthorizationCallbacks>
  /** Builds the links in account emails. Each enabled flow needs its builder. */
  urls: Partial<UrlCallbacks>
  /** Sends account emails. Each enabled flow needs its callbacks. */
  notify: Partial<NotificationCallbacks>
  /** Application-owned delivery guarantee; durable requires an application queue or outbox. */
  delivery?: 'best-effort' | 'durable' | 'capture'
  /**
   * Runs inside the acceptance transaction, for example to assign the invitation's role. Use `trx`
   * for every write; throwing rolls back the new account.
   */
  onInvitationAccepted?: (user: AccountUser, invitation: Invitation, trx: Trx) => Promise<void>
  /**
   * Runs after commit when credentials change. Prefer `onCredentialsChangedTransaction`; the two
   * are mutually exclusive.
   */
  onCredentialsChanged?: (user: AccountUser, context: CredentialChangeContext) => Promise<void>
  /**
   * Runs inside the transaction that issues a reset link, after the old link is replaced. Throwing
   * keeps the previous link. Keep it database-only: SQLite may retry it.
   */
  onPasswordResetIssuedTransaction?: (user: AccountUser, trx: Trx) => Promise<void>
  /**
   * Revokes your own sessions or tokens in the same transaction as a password or email change.
   * Required when credentials can change; a no-op is a deliberate choice.
   */
  onCredentialsChangedTransaction?: (
    user: AccountUser,
    context: CredentialChangeContext,
    trx: Trx
  ) => Promise<void>
  /** Receives account events after commit, for audit logs. */
  onLifecycleEvent?: (event: LifecycleEvent) => Promise<void>
  /**
   * The users table for a custom adapter without `resolveMetadata`. Default `users`. The Lucid
   * adapter derives it.
   */
  usersTable?: string
  /** The name of the unique email constraint, for a custom adapter. */
  emailConstraint?: string
  /**
   * A stable secret of at least 32 bytes, normally `env.get('APP_KEY')`. Limiter keys are HMACs of
   * it, so the store never holds an email or IP.
   */
  limiterSecret: Secret<string> | string
  /** Separates limiter keys for apps sharing a store. Default `default`. */
  limiterNamespace?: string
  /**
   * How long each kind of link stays valid, as a duration string or seconds. Defaults: reset,
   * verification and email change 1h, invitation 7d, magic link 15m.
   */
  expiresIn?: {
    passwordReset?: string | number
    emailVerification?: string | number
    invitation?: string | number
    emailChange?: string | number
    magicLink?: string | number
  }
  /** The general per-identity rate limit. Default 5 requests per 15 minutes. */
  throttle?: Partial<ThrottleBudget>
  /** Invitation rate limits, overriding the defaults one at a time. */
  invitationThrottle?: Partial<InvitationThrottle>
  /**
   * The minimum time a reset or magic-link request takes, so the response time does not reveal
   * whether the address exists. Default 300; keep it above the password hash cost.
   */
  minRequestMs?: number
  /** Random bytes in each proof token. Default 40, from 16 to 64. */
  tokenSecretLength?: number
  /**
   * Signs people in through your existing Auth guard. Needed for login, magic links and signed-in
   * devices.
   */
  authentication?: AuthenticationConfig
  /** Who may sign up. Required even when `registration` is not enabled. */
  registration: {
    availability: 'open' | 'closed' | 'application'
    mapFields?: (input: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>
  }
  /** Rules for new passwords, overriding the defaults one at a time. */
  passwordPolicy?: Partial<PasswordPolicy>
  /** Google and GitHub providers, for `socialAuthentication`. */
  socialAuthentication?: SocialAuthenticationConfig
  /** Options for `sessionManagement`. */
  sessionManagement?: SessionManagementConfig
  /**
   * Application data for the account export. Runs inside the export transaction; return a
   * JSON-serializable value. Its result becomes the export's `application` section.
   */
  exportAccountData?: (user: AccountUser, trx: Trx) => Promise<unknown>
  /**
   * Delete or anonymise application rows before the user row is deleted. Use only trx and no
   * remote side effects: it may run again when SQLite retries a busy transaction. Throwing
   * aborts the deletion.
   */
  onAccountDeletingTransaction?: (user: AccountUser, trx: Trx) => Promise<void>
  /** Options for `accountDeletion`. */
  accountDeletion?: AccountDeletionConfig
}

/** Options for `accountDeletion`. */
export interface AccountDeletionConfig {
  /** Invitations the user sent: `revoke` (default) deletes them, `keep` leaves them acceptable. */
  invitations?: 'keep' | 'revoke'
}

/** Options for `sessionManagement`. */
export interface SessionManagementConfig {
  /** A sign-in unused for this long is signed out. Default `30d`; must exceed five minutes. */
  idleExpiry?: string | number
}

/**
 * Rules for new passwords. Applies to registration, reset, invitation acceptance, activation and
 * password change; login still accepts an existing password.
 */
export interface PasswordPolicy {
  /** Minimum length, at least 8. Default 8. */
  minLength: number
  /** Maximum length, or null for the service ceiling of 256. Default null. */
  maxLength: number | null
  /** Require a letter. Default false. */
  letters: boolean
  /** Require upper and lower case. Default false. */
  mixedCase: boolean
  /** Require a digit. Default false. */
  numbers: boolean
  /** Require a symbol. Default false. */
  symbols: boolean
  /**
   * Minimum strength score, 0 to 4, from the estimated entropy of the password's length and
   * character mix (under 28 bits scores 0; 110 or more scores 4). Default 0.
   */
  minScore: 0 | 1 | 2 | 3 | 4
}

/** A supported social provider: `google` or `github`. */
export type SocialProviderName = (typeof socialProviderNames)[number]
/** What a social flow is for: `login`, `link`, `reauth`, or `confirm` to finish a pending link. */
export type SocialIntent = (typeof socialIntents)[number]
/** The action a recent-authentication proof allows. A proof works once, for its purpose only. */
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
  /** Returns the provider's authorization URL carrying Account Kit's `state`. */
  authorizationUrl(state: string, context?: unknown): Promise<string>
  /** Reads the provider profile from the callback request. Provider tokens must not be returned. */
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

/** Configuration for `socialAuthentication`: one adapter per enabled provider. */
export interface SocialAuthenticationConfig {
  /** One adapter per enabled provider, usually from `createAllySocialProvider`. */
  providers: Partial<Record<SocialProviderName, SocialProvider>>
}

/** A provider account linked to a local user. `providerUserId` is the provider's stable subject. */
export interface SocialIdentity {
  id: number
  userId: UserId
  provider: SocialProviderName
  /** The provider's stable, case-sensitive subject. */
  providerUserId: string
  /** The email the provider reported. Never used to merge accounts. */
  email: string | null
  /** Whether the provider said the email is verified. */
  emailVerified: boolean
}

/** Input for `socialAuthentication.begin`. */
export interface SocialBeginInput {
  /** The provider to start with. */
  provider: SocialProviderName
  /** `login`, `link` or `reauth`. */
  intent: Exclude<SocialIntent, 'confirm'>
  /** The signed-in credential. Required for `link` and `reauth`. */
  current?: CurrentAccountInput
  /** The action a `reauth` proof is for. */
  purpose?: SensitivePurpose
  /** SHA-256 base64url challenge of a verifier held by the initiating client. */
  clientChallenge: string
  /** Opaque request context for a request-scoped provider adapter. */
  context?: unknown
  /** Recent social_link proof kept in the server transaction, never in the provider URL. */
  proof?: string
}

/** Input for `socialAuthentication.callback`, with the request-scoped provider callback. */
export interface SocialCallbackInput {
  /** The one-use state from the callback query. */
  state: string
  /** The route provider, when the caller has a provider-specific callback URL. */
  provider?: SocialProviderName
  /** The request-scoped value your provider adapter's `resolve` reads, such as the Ally context. */
  callback: unknown
  intent?: SocialIntent
  /** The signed-in credential, for `link` and `reauth`. */
  current?: CurrentAccountInput
  /** A fresh proof supplied directly to a link callback. */
  proof?: string
  /** The email proof that confirms a pending identity. */
  verificationToken?: string
}

/**
 * The outcome of a provider callback: signed in (`linked`), needs more data or verification
 * (`new`), needs linking from a signed-in account (`link_required`), or a fresh proof
 * (`reauthenticated`).
 */
export type SocialCallbackResult =
  | { status: 'linked' | 'new'; userId: UserId; handoffCode?: string }
  | { status: 'new'; continuation: string }
  | { status: 'new'; emailVerificationRequired: true }
  | { status: 'link_required' }
  | { status: 'reauthenticated'; proof: string }

/** Signs people in through an existing AdonisJS Auth guard. */
export interface AuthenticationConfig {
  /** The guard type: `session` or `access_tokens`. */
  strategy: 'session' | 'access_tokens'
  /** The name of the existing guard in `config/auth.ts`. */
  guard: string
  /** Return false to deny login and protected access. Called under the account lock. */
  canAccess?: (user: AccountUser, trx: Trx) => Promise<boolean>
  /** Failed logins allowed per client. Default 10 per minute. */
  clientLimit?: ThrottleBudget
  /**
   * Failed logins allowed per client and email. Default 5 per minute, then blocked for 20 minutes.
   */
  identityLimit?: ThrottleBudget & { blockDuration?: string }
  /** Abilities on issued access tokens. Default `['*']`. */
  tokenAbilities?: string[]
  /** Access-token lifetime. Omitted means tokens do not expire. */
  tokenExpiresIn?: string | number
  /** The access-token table. Default `auth_access_tokens`. */
  tokenTable?: string
}

/** `AuthenticationConfig` with every default filled in. */
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

/** Input for `authentication.login`. */
export interface PasswordLoginInput {
  /** The address the user typed. */
  email: string
  /** The password the user typed. */
  password: string
  /** Stable, trusted client identity derived after proxy configuration. */
  clientKey: string
  /** Untrusted display text for the sign-in list, such as a User-Agent; at most 255 characters. */
  sessionLabel?: string
}

/** Safe account data for the signed-in user. `active` is false until the address is confirmed. */
export interface CurrentAccount {
  id: UserId
  email: string
  /** An address waiting for confirmation, or null. */
  unverifiedEmail: string | null
  /** False for an account that signs in only through a social provider. */
  hasPassword: boolean
  /** False until the address is confirmed. */
  active: boolean
}

/** Identifies the signed-in credential so Account Kit can check it is still valid. */
export interface CurrentAccountInput {
  /** The id your guard authenticated. */
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
  /** Pass it to `sessions.revoke`. */
  id: number
  /** Display text recorded at login, such as a User-Agent. Untrusted. */
  label: string | null
  /** When the user signed in, as an ISO 8601 string. */
  createdAt: string
  /** When the sign-in was last used, or null. */
  lastSeenAt: string | null
  /** When it expires, or null for a token without expiry. */
  expiresAt: string | null
  /** True for the sign-in making this request. */
  current: boolean
}

/**
 * Adapts your AdonisJS guard so Account Kit can create and end real sessions or tokens.
 * `createManagedGuard` builds one.
 */
export type AuthenticationGuard<Credential> =
  | {
      strategy: 'session'
      name: string
      /** `handle` is set when `sessionManagement` is enabled; store it in the session. */
      establish(userId: UserId, revision: string | null, handle?: string): Promise<Credential>
      terminate(credential?: Credential): Promise<void>
      /** Store a new revision for the current session, where `establish` stored the first one. */
      refresh?(revision: string | null): Promise<void>
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

/** `AccountKitConfig` after `defineConfig` has validated it and filled in every default. */
export interface ResolvedConfig extends Omit<
  AccountKitConfig,
  | 'enabled'
  | 'authorize'
  | 'urls'
  | 'notify'
  | 'delivery'
  | 'onInvitationAccepted'
  | 'usersTable'
  | 'limiterSecret'
  | 'limiterNamespace'
  | 'expiresIn'
  | 'throttle'
  | 'invitationThrottle'
  | 'minRequestMs'
  | 'authentication'
  | 'passwordPolicy'
  | 'sessionManagement'
  | 'accountDeletion'
> {
  enabled: Capability[]
  authorize: AuthorizationCallbacks
  urls: UrlCallbacks
  notify: NotificationCallbacks
  delivery: 'best-effort' | 'durable' | 'capture'
  onInvitationAccepted: NonNullable<AccountKitConfig['onInvitationAccepted']>
  usersTable: string
  limiterSecret: string
  limiterNamespace: string
  expiresIn: Required<NonNullable<AccountKitConfig['expiresIn']>>
  throttle: ThrottleBudget
  invitationThrottle: InvitationThrottle
  minRequestMs: number
  tokenSecretLength: number
  authentication?: ResolvedAuthenticationConfig
  passwordPolicy: PasswordPolicy
  sessionManagement: Required<SessionManagementConfig>
  accountDeletion: Required<AccountDeletionConfig>
}

/**
 * Input for `registration.register`. `registrationData` is untrusted and goes through
 * `registration.mapFields`.
 */
export interface RegistrationInput {
  email: string
  password: string
  /** Untrusted extra fields, passed to `registration.mapFields`. */
  registrationData?: unknown
}

/** How an operator command delivers its link: `send` emails it, `print` returns it. */
export type OperatorDelivery = 'send' | 'print'

/** Input for `operator.invite`. */
export interface OperatorInviteInput {
  email: string
  /** The role to grant on acceptance. */
  role: string
  /** `send` notifies the invitee; `print` returns the acceptance URL instead. */
  deliver: OperatorDelivery
}

/** Input for `operator.resetLink`. */
export interface OperatorResetLinkInput {
  email: string
  /** `send` emails the link; `print` returns it. */
  deliver: OperatorDelivery
}

/** A committed follow-up failure, reduced to safe fields: no cause, stack, or URL. */
export interface OperatorFault {
  name: string
  message: string
}

/** The invitation, its URL when printed, and any follow-up failure after commit. */
export interface OperatorInviteResult {
  invitation: Invitation
  /** The acceptance link, when `deliver` was `print`. */
  url?: string
  /** A failure after the invitation was saved, such as a failed email. */
  fault?: OperatorFault
}

/** The user, the reset URL when printed, and any follow-up failure after commit. */
export interface OperatorResetLinkResult {
  user: AccountUser
  /** The reset link, when `deliver` was `print`. */
  url?: string
  /** A failure after the link was saved, such as a failed email. */
  fault?: OperatorFault
}

/**
 * One page of invitations. Pass `nextCursor` as `cursor` for the next page; null means there are no
 * more.
 */
export interface InvitationPage {
  items: Invitation[]
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null
}

/**
 * Input for `passwordReset.request`. `clientKey` is a trusted client identity such as the request
 * IP.
 */
export interface PasswordResetRequestInput {
  /** The address the user typed. */
  email: string
  /**
   * A trusted client identity for rate limits, normally `request.ip()` behind configured trusted
   * proxies.
   */
  clientKey: string
}
/** Input for `passwordReset.inspect`. */
export interface PasswordResetInspectInput {
  /** The proof token from the link. */
  token: string
}
/** Input for `passwordReset.reset`. */
export interface PasswordResetCompleteInput {
  /** The proof token from the link. */
  token: string
  /** The new password. Checked against `passwordPolicy`. */
  password: string
}
/** Input for `magicLink.request`. */
export interface MagicLinkRequestInput {
  /** The address the user typed. */
  email: string
  /** A trusted client identity for rate limits, normally `request.ip()`. */
  clientKey: string
  /** Base64url SHA-256 of a verifier the requesting client keeps; 43 characters. */
  clientChallenge: string
}
/** Input for `magicLink.inspect`. */
export interface MagicLinkInspectInput {
  /** The proof token from the link. */
  token: string
}
/** Input for `magicLink.complete`. */
export interface MagicLinkCompleteInput {
  /** The proof token from the link. */
  token: string
  /** The verifier whose challenge was sent with the request. */
  verifier: string
}
/** Input for `emailVerification.send`. */
export interface VerificationSendInput {
  /** The account to send a new activation link to. */
  userId: UserId
}
/** Input for `emailVerification.inspect`. */
export interface VerificationInspectInput {
  /** The proof token from the link. */
  token: string
}
/** Input for `emailVerification.complete`. Activation sets a fresh password. */
export interface VerificationCompleteInput {
  /** The proof token from the link. */
  token: string
  /** The password to set on activation. Checked against `passwordPolicy`. */
  password: string
}
/** Input for `invitations.send`. */
export interface InvitationsSendInput {
  /** The signed-in user sending the invitation. */
  actorId: UserId
  /** The address to invite. */
  email: string
  /** The role to grant on acceptance. */
  role: string
}
/** Input for `invitations.list`. `limit` defaults to 25, at most 100. */
export interface InvitationsListInput {
  /** The signed-in user listing invitations. */
  actorId: UserId
  /** Page size. Default 25, at most 100. */
  limit?: number
  /** `nextCursor` from the previous page. */
  cursor?: string
}
/** Input for `invitations.inspect`. */
export interface InvitationsInspectInput {
  /** The proof token from the link. */
  token: string
}
/** Input for `invitations.accept`. */
export interface InvitationsAcceptInput {
  /** The proof token from the link. */
  token: string
  /** The new account's password. Checked against `passwordPolicy`. */
  password: string
  /** Untrusted extra fields, passed to `registration.mapFields`. */
  registrationData?: unknown
}
/** Input for `invitations.resend`. */
export interface InvitationsResendInput {
  /** The signed-in user resending. */
  actorId: UserId
  /** The invitation to resend. */
  invitationId: number
}
/** Input for `invitations.revoke`. */
export interface InvitationsRevokeInput {
  /** The signed-in user revoking. */
  actorId: UserId
  /** The invitation to revoke. */
  invitationId: number
}
/**
 * Input for `emailPasswordManagement.changePassword`. Give `currentPassword`, or `recentProof` for
 * a social-only account.
 */
export interface ChangePasswordInput {
  /** The signed-in user. */
  actorId: UserId
  /** The user's current password. */
  currentPassword?: string
  /** Purpose-bound proof issued by a fresh provider reauthentication for social-only accounts. */
  recentProof?: string
  /** The new password. Checked against `passwordPolicy`. */
  newPassword: string
  /**
   * The caller's own sign-in, from `authentication.current` input, to keep while every other one
   * ends. A handle or id that matches nothing ends every sign-in.
   */
  keepCurrent?: { sessionHandle?: string; tokenId?: UserId }
}
/**
 * Input for `emailPasswordManagement.requestEmailChange`. Give `currentPassword`, or `recentProof`
 * for a social-only account.
 */
export interface RequestEmailChangeInput {
  /** The signed-in user. */
  actorId: UserId
  /** The user's current password. */
  currentPassword?: string
  /** A purpose-bound proof, for a social-only account. */
  recentProof?: string
  /** The address to switch to once confirmed. */
  newEmail: string
}
/**
 * Input for `emailPasswordManagement.updateProfile`. An email change needs `currentPassword` or
 * `recentProof`.
 */
export interface UpdateProfileInput {
  /** The signed-in user. */
  actorId: UserId
  /** The user's current password. Required when `email` changes. */
  currentPassword?: string
  /** A purpose-bound proof, for a social-only account. */
  recentProof?: string
  /** A new address; starts an email change when it differs. */
  email?: string
  /** Untrusted extra fields, passed to `registration.mapFields`. */
  registrationData?: unknown
}
/** Input for `emailPasswordManagement.completeEmailChange`. */
export interface CompleteEmailChangeInput {
  /** The proof token from the link. */
  token: string
}
/** Input for `emailPasswordManagement.inspectEmailChange`. */
export interface InspectEmailChangeInput {
  /** The proof token from the link. */
  token: string
}

/** Fresh re-authentication for export and deletion, as for a password change. */
export interface AccountDataInput {
  /** The signed-in user. */
  actorId: UserId
  /** The user's current password. */
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
