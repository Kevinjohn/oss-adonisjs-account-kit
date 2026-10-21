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
  findOrFail(id: UserId): Promise<User>
}

/** A user model with an AdonisJS access-token provider, for a token guard. */
export interface ManagedTokenModel<User> extends ManagedUserModel<User> {
  accessTokens: {
    create(
      user: User,
      abilities: string[],
      options?: { expiresIn?: string | number; name?: string }
    ): Promise<{
      identifier: UserId | BigInt
      value?: { release(): string } | null
    }>
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
  forRequest(context: HttpContext): Extract<AuthenticationGuard<undefined>, { strategy: 'session' }>
}
/** Adapts an existing access-token guard for the managed routes. */
export function createManagedGuard<User>(options: ManagedTokenGuardOptions<User>): Omit<
  ManagedGuard<ManagedTokenCredential>,
  'strategy' | 'forRequest' | 'logoutCredential'
> & {
  strategy: 'access_tokens'
  forRequest(
    context: HttpContext
  ): Extract<AuthenticationGuard<ManagedTokenCredential>, { strategy: 'access_tokens' }>
  logoutCredential(context: HttpContext): Promise<ManagedTokenCredential>
  publicCredential(credential: ManagedTokenCredential): string
}
export function createManagedGuard<User>(
  options: ManagedSessionGuardOptions<User> | ManagedTokenGuardOptions<User>
): ManagedGuard<undefined | ManagedTokenCredential> {
  return options.strategy === 'session' ? createSessionGuard(options) : createTokenGuard(options)
}
