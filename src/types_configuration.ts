import type { Secret } from '@adonisjs/core/helpers'
import type {
  Trx,
  AccountUser,
  UsersAdapter,
  Invitation,
  Capability,
  CredentialChangeContext,
  SessionsRevokedContext,
  LifecycleEvent,
  AuthorizationCallbacks,
  UrlCallbacks,
  NotificationCallbacks,
  ThrottleBudget,
  InvitationThrottle,
  SocialAuthenticationConfig,
  AuthenticationConfig,
  ResolvedAuthenticationConfig,
} from './types.js'

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
  /**
   * Runs inside the transaction of `authentication.sessions.revoke` and `revokeOthers`, after the
   * rows are deleted. Use `trx` for every write; throwing keeps the sign-ins. For rows bound to a
   * sign-in prefer a foreign key with `ON DELETE CASCADE`, which also covers logout, pruning,
   * credential changes and account deletion; this hook is for audit or outbox rows. Keep it
   * database-only: SQLite may retry it.
   */
  onSessionsRevokedTransaction?: (
    user: AccountUser,
    context: SessionsRevokedContext,
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
