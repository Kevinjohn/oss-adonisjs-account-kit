import type { HttpContext } from '@adonisjs/core/http'
import type { AuthenticationGuard } from '../types.ts'
import type { ManagedGuard } from './managed_types.ts'
import { createSessionGuard } from './managed_session_guard.ts'
import { createTokenGuard } from './managed_token_guard.ts'
import type {
  ManagedSessionGuardOptions,
  ManagedTokenCredential,
  ManagedTokenGuardOptions,
} from './guard_types.ts'

export type * from './guard_types.ts'

/**
 * Adapts an existing session guard for the managed routes. The session store must be server-side.
 *
 * @example
 * ```ts
 * import { createManagedGuard } from '@kevinjohn/adonisjs-account-kit/http'
 *
 * const guard = createManagedGuard({
 *   strategy: 'session',
 *   name: 'web',
 *   loadUser: async () => (await import('#models/user')).default,
 * })
 * ```
 */
export function createManagedGuard<User>(options: ManagedSessionGuardOptions<User>): Omit<
  ManagedGuard<undefined>,
  'strategy' | 'forRequest'
> & {
  strategy: 'session'
  /**
   * The guard bound to one request's session.
   *
   * @example
   * ```ts
   * const sessionGuard = guard.forRequest(context)
   * ```
   */
  forRequest(context: HttpContext): Extract<AuthenticationGuard<undefined>, { strategy: 'session' }>
}
/**
 * Adapts an existing access-token guard for the managed routes.
 *
 * @example
 * ```ts
 * import { createManagedGuard } from '@kevinjohn/adonisjs-account-kit/http'
 *
 * const guard = createManagedGuard({
 *   strategy: 'access_tokens',
 *   name: 'api',
 *   loadUser: async () => (await import('#models/user')).default,
 * })
 * ```
 */
export function createManagedGuard<User>(options: ManagedTokenGuardOptions<User>): Omit<
  ManagedGuard<ManagedTokenCredential>,
  'strategy' | 'forRequest' | 'logoutCredential'
> & {
  strategy: 'access_tokens'
  /**
   * The guard bound to one request's bearer token.
   *
   * @example
   * ```ts
   * const requestGuard = tokenGuard.forRequest(context)
   * ```
   */
  forRequest(
    context: HttpContext
  ): Extract<AuthenticationGuard<ManagedTokenCredential>, { strategy: 'access_tokens' }>
  /**
   * The token that authenticated the request, for `terminate` on logout.
   *
   * @example
   * ```ts
   * const credential = await tokenGuard.logoutCredential(context)
   * ```
   */
  logoutCredential(context: HttpContext): Promise<ManagedTokenCredential>
  /**
   * The plaintext token to return to the client, released once.
   *
   * @example
   * ```ts
   * const bearer = tokenGuard.publicCredential(credential)
   * ```
   */
  publicCredential(credential: ManagedTokenCredential): string
}
export function createManagedGuard<User>(
  options: ManagedSessionGuardOptions<User> | ManagedTokenGuardOptions<User>
): ManagedGuard<undefined | ManagedTokenCredential> {
  return options.strategy === 'session' ? createSessionGuard(options) : createTokenGuard(options)
}
