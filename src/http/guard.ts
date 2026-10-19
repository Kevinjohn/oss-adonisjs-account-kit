import type { HttpContext } from '@adonisjs/core/http'
import { InvalidSessionError } from '../errors.js'
import type { AccountKit } from '../account_kit.js'
import type { AuthenticationGuard, UserId } from '../types.js'
import type { ManagedGuard } from './managed.js'
import { assertManagedSessionStore } from './session_store_protection.js'

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

type SessionContext<User> = HttpContext & {
  auth: {
    use(name: string): {
      authenticate(): Promise<User>
      login(user: User): Promise<void>
      logout(): Promise<void>
    }
  }
  session: {
    config?: unknown
    regenerate(): void
    put(key: string, value: string): void
    get(key: string): unknown
    clear(): void
  }
}
type TokenContext<User> = HttpContext & {
  auth: { use(name: string): { authenticate(): Promise<User> } }
}

const revisionKey = 'accountKitRevision'
const handleKey = 'accountKitSession'

function managedUser(value: unknown): ManagedUser {
  if (!value || typeof value !== 'object') throw new InvalidSessionError()
  const id = (value as { id?: unknown }).id
  if (typeof id !== 'number' && typeof id !== 'string') throw new InvalidSessionError()
  return value as ManagedUser
}

function normalizedIdentifier(value: unknown): UserId {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'number' && typeof value !== 'string') throw new InvalidSessionError()
  return value
}

function tokenIdentifier(value: unknown): UserId {
  if (!value || typeof value !== 'object') throw new InvalidSessionError()
  const token = (value as { currentAccessToken?: unknown }).currentAccessToken
  if (!token || typeof token !== 'object') throw new InvalidSessionError()
  const id = (token as { identifier?: unknown }).identifier
  return normalizedIdentifier(id)
}

async function authenticate<User>(guard: { authenticate(): Promise<User> }): Promise<User> {
  try {
    return await guard.authenticate()
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'E_UNAUTHORIZED_ACCESS'
    )
      throw new InvalidSessionError()
    throw error
  }
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
  if (options.strategy === 'session') {
    return {
      strategy: 'session',
      name: options.name,
      async current(context) {
        const ctx = context as SessionContext<User>
        assertManagedSessionStore(ctx)
        const user = await authenticate(ctx.auth.use(options.name))
        const stored = ctx.session.get(revisionKey)
        if (stored !== undefined && typeof stored !== 'string') throw new InvalidSessionError()
        const handle = ctx.session.get(handleKey)
        if (handle !== undefined && typeof handle !== 'string') throw new InvalidSessionError()
        return {
          userId: managedUser(user).id,
          ...(stored === undefined ? {} : { revision: stored === '' ? null : stored }),
          ...(handle ? { sessionHandle: handle } : {}),
        }
      },
      forRequest(context) {
        const ctx = context as SessionContext<User>
        assertManagedSessionStore(ctx)
        return {
          strategy: 'session',
          name: options.name,
          async establish(userId, revision, handle) {
            const model = await options.loadUser()
            ctx.session.regenerate()
            await ctx.auth.use(options.name).login(await model.findOrFail(userId))
            ctx.session.put(revisionKey, revision ?? '')
            if (handle) ctx.session.put(handleKey, handle)
            return undefined
          },
          async terminate() {
            await ctx.auth.use(options.name).logout()
            ctx.session.clear()
            ctx.session.regenerate()
          },
        }
      },
    }
  }
  return {
    strategy: 'access_tokens',
    name: options.name,
    publicCredential(credential: ManagedTokenCredential) {
      if (!credential.value) throw new Error('Token guard did not return a bearer value')
      return credential.value
    },
    async current(context) {
      const user = await authenticate((context as TokenContext<User>).auth.use(options.name))
      return { userId: managedUser(user).id, tokenId: tokenIdentifier(user) }
    },
    async logoutCredential(context) {
      const user = await authenticate((context as TokenContext<User>).auth.use(options.name))
      return { userId: managedUser(user).id, identifier: tokenIdentifier(user) }
    },
    forRequest(_context) {
      return {
        strategy: 'access_tokens',
        name: options.name,
        async establish(userId, abilities, expiresIn, issue) {
          const model = await options.loadUser()
          const user = await model.findOrFail(userId)
          const createOptions = {
            ...(expiresIn === null ? {} : { expiresIn }),
            ...(issue?.name ? { name: issue.name } : {}),
          }
          const token = await model.accessTokens.create(
            user,
            abilities,
            Object.keys(createOptions).length ? createOptions : undefined
          )
          try {
            if (!token.value) throw new Error('Token guard did not return a bearer value')
            const identifier = normalizedIdentifier(token.identifier)
            const value = token.value.release()
            if (!value) throw new Error('Token guard did not return a bearer value')
            return { userId, identifier, value }
          } catch (error) {
            try {
              await model.accessTokens.delete(user, token.identifier)
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                'Token issuance failed and cleanup failed'
              )
            }
            throw error
          }
        },
        async terminate(credential) {
          if (!credential) return
          const model = await options.loadUser()
          await model.accessTokens.delete(
            await model.findOrFail(credential.userId),
            credential.identifier
          )
        },
      }
    },
  }
}

/** Apply the same selected guard and package revision check to application-owned routes. */
export function managedAccountMiddleware<Credential>(options: {
  kit(): Promise<Pick<AccountKit, 'managedHttp' | 'authentication'>>
  guard: Pick<ManagedGuard<Credential>, 'current' | 'name' | 'strategy'>
  active: boolean
}): (context: HttpContext, next: () => Promise<unknown>) => Promise<unknown> {
  return async (context, next) => {
    const kit = await options.kit()
    kit.managedHttp.assertGuard(options.guard)
    const input = await options.guard.current(context)
    if (options.active) await kit.authentication.requireActive(input)
    else await kit.authentication.current(input)
    return next()
  }
}
