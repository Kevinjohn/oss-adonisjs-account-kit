import type { HttpContext } from '@adonisjs/core/http'
import type { AuthenticationGuard, UserId } from '../types.js'
import type { ManagedGuard } from './managed_types.js'
import { createSessionGuard } from './managed_session_guard.js'
import { createTokenGuard } from './managed_token_guard.js'

export { managedAccountMiddleware } from './managed_account_middleware.js'

/** The user fields the managed guard reads. */
export interface ManagedUser {
  id: UserId
  currentAccessToken?: { identifier: UserId | BigInt }
}

/** A user model the managed guard can load users from. */
export interface ManagedUserModel<User> {
  /** Load a user by id; throws when there is none. */
  findOrFail(id: UserId): Promise<User>
}

/** A user model with an AdonisJS access-token provider, for a token guard. */
export interface ManagedTokenModel<User> extends ManagedUserModel<User> {
  accessTokens: {
    /** Issue a token; `value.release()` returns the plaintext token once. */
    create(
      user: User,
      abilities: string[],
      options?: { expiresIn?: string | number; name?: string }
    ): Promise<{
      identifier: UserId | BigInt
      /** Set when a token was just created; `release` returns its plaintext once. */
      value?: {
        /** The plaintext token; AdonisJS lets it be read once. */
        release(): string
      } | null
    }>
    /** Revoke one of the user's tokens by its identifier. */
    delete(user: User, identifier: UserId | BigInt): Promise<unknown>
  }
}

/**
 * An access token issued by the managed token guard. `value` is the bearer secret, present only
 * right after issuance.
 */
export interface ManagedTokenCredential {
  /** The user the token belongs to. */
  userId: UserId
  /** The token row id. */
  identifier: UserId
  /** The bearer secret. Present only right after issuance; return it once and never log it. */
  value?: string
}

/** Options for `createManagedGuard` with an existing session guard. */
export type ManagedSessionGuardOptions<User> = {
  /** Always `session`. */
  strategy: 'session'
  /** The existing session guard's name in `config/auth.ts`. */
  name: string
  /** Loads the user model lazily. */
  loadUser(): Promise<ManagedUserModel<User>>
}
/** Options for `createManagedGuard` with an existing access-token guard. */
export type ManagedTokenGuardOptions<User> = {
  /** Always `access_tokens`. */
  strategy: 'access_tokens'
  /** The existing access-token guard's name in `config/auth.ts`. */
  name: string
  /** Loads the user model, which must have an `accessTokens` provider. */
  loadUser(): Promise<ManagedTokenModel<User>>
}

/**
 * Adapts an existing session guard for the managed routes. The session store must be server-side.
 */
export function createManagedGuard<User>(options: ManagedSessionGuardOptions<User>): Omit<
  ManagedGuard<undefined>,
  'strategy' | 'forRequest'
> & {
  strategy: 'session'
  /** The guard bound to one request's session. */
  forRequest(context: HttpContext): Extract<AuthenticationGuard<undefined>, { strategy: 'session' }>
}
/** Adapts an existing access-token guard for the managed routes. */
export function createManagedGuard<User>(options: ManagedTokenGuardOptions<User>): Omit<
  ManagedGuard<ManagedTokenCredential>,
  'strategy' | 'forRequest' | 'logoutCredential'
> & {
  strategy: 'access_tokens'
  /** The guard bound to one request's bearer token. */
  forRequest(
    context: HttpContext
  ): Extract<AuthenticationGuard<ManagedTokenCredential>, { strategy: 'access_tokens' }>
  /** The token that authenticated the request, for `terminate` on logout. */
  logoutCredential(context: HttpContext): Promise<ManagedTokenCredential>
  /** The plaintext token to return to the client, released once. */
  publicCredential(credential: ManagedTokenCredential): string
}
export function createManagedGuard<User>(
  options: ManagedSessionGuardOptions<User> | ManagedTokenGuardOptions<User>
): ManagedGuard<undefined | ManagedTokenCredential> {
  return options.strategy === 'session' ? createSessionGuard(options) : createTokenGuard(options)
}
