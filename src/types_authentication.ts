import type { Trx, UserId, AccountUser, ThrottleBudget } from './types.js'

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

/**
 * Input for caller-authorized inspection. Adapters and policy callbacks must be read-only through
 * the supplied transaction and safe to retry; unavailable accounts share `AccountAccessDeniedError`.
 */
export interface AccountAccessInput {
  /** The account to inspect. No credential for it is needed or accepted. */
  userId: UserId
  /** When true, an account whose address is still unconfirmed is denied. */
  requireActive: boolean
}

/**
 * One point-in-time read of account eligibility and credential revision, not lasting authorization.
 * A `PostCommitError` discards this result; retry is safe under the inspection dependency contract.
 */
export interface AccountAccessSnapshot {
  account: CurrentAccount
  /** The canonical UTC revision, or null before the first credential change. */
  revision: string | null
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
