import type { HttpContext } from '@adonisjs/core/http'
import { InvalidSessionError } from '../errors.js'
import type { AccountKit } from '../account_kit.js'
import type { AuthenticationGuard, UserId } from '../types.js'
import type { ManagedGuard } from './managed.js'

export interface ManagedUser {
  id: UserId
  currentAccessToken?: { identifier: UserId }
}

export interface ManagedUserModel<User> {
  findOrFail(id: UserId): Promise<User>
}

export interface ManagedTokenModel<User> extends ManagedUserModel<User> {
  accessTokens: {
    create(
      user: User,
      abilities: string[],
      options?: { expiresIn: string | number }
    ): Promise<{
      identifier: UserId
      value: { release(): string } | null
    }>
    delete(user: User, identifier: UserId): Promise<void>
  }
}

export interface ManagedTokenCredential {
  userId: UserId
  identifier: UserId
  value?: string
}

type SessionOptions<User> = {
  strategy: 'session'
  name: string
  loadUser(): Promise<ManagedUserModel<User>>
}
type TokenOptions<User> = {
  strategy: 'access_tokens'
  name: string
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
    config?: { store?: string }
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

function assertServerSession(context: SessionContext<unknown>): void {
  if (context.session?.config?.store === 'cookie')
    throw new Error('Managed session authentication requires a server-side session store')
}

function managedUser(value: unknown): ManagedUser {
  if (!value || typeof value !== 'object') throw new InvalidSessionError()
  const id = (value as { id?: unknown }).id
  if (typeof id !== 'number' && typeof id !== 'string') throw new InvalidSessionError()
  return value as ManagedUser
}

function tokenIdentifier(value: unknown): UserId {
  if (!value || typeof value !== 'object') throw new InvalidSessionError()
  const token = (value as { currentAccessToken?: unknown }).currentAccessToken
  if (!token || typeof token !== 'object') throw new InvalidSessionError()
  const id = (token as { identifier?: unknown }).identifier
  if (typeof id !== 'number' && typeof id !== 'string') throw new InvalidSessionError()
  return id
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

export function createManagedGuard<User>(options: SessionOptions<User>): Omit<
  ManagedGuard<undefined>,
  'strategy' | 'forRequest'
> & {
  strategy: 'session'
  forRequest(context: HttpContext): Extract<AuthenticationGuard<undefined>, { strategy: 'session' }>
}
export function createManagedGuard<User>(options: TokenOptions<User>): Omit<
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
  options: SessionOptions<User> | TokenOptions<User>
): ManagedGuard<undefined | ManagedTokenCredential> {
  if (options.strategy === 'session') {
    return {
      strategy: 'session',
      name: options.name,
      async current(context) {
        const ctx = context as SessionContext<User>
        assertServerSession(ctx)
        const user = await authenticate(ctx.auth.use(options.name))
        const stored = ctx.session.get(revisionKey)
        if (stored !== undefined && typeof stored !== 'string') throw new InvalidSessionError()
        return {
          userId: managedUser(user).id,
          ...(stored === undefined ? {} : { revision: stored === '' ? null : stored }),
        }
      },
      forRequest(context) {
        const ctx = context as SessionContext<User>
        assertServerSession(ctx)
        return {
          strategy: 'session',
          name: options.name,
          async establish(userId, revision) {
            const model = await options.loadUser()
            ctx.session.regenerate()
            await ctx.auth.use(options.name).login(await model.findOrFail(userId))
            ctx.session.put(revisionKey, revision ?? '')
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
        async establish(userId, abilities, expiresIn) {
          const model = await options.loadUser()
          const user = await model.findOrFail(userId)
          const token = await model.accessTokens.create(
            user,
            abilities,
            expiresIn === null ? undefined : { expiresIn }
          )
          if (!token.value) throw new Error('Token guard did not return a bearer value')
          return { userId, identifier: token.identifier, value: token.value.release() }
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
  kit(): Promise<AccountKit>
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
