import type { HttpContext } from '@adonisjs/core/http'
import { InvalidSessionError } from '../errors.js'
import type { ManagedGuard } from './managed_types.js'
import type { ManagedSessionGuardOptions, ManagedUser } from './guard.js'
import { assertManagedSessionStore } from './session_store_protection.js'

function managedUser(value: unknown): ManagedUser {
  if (!value || typeof value !== 'object') throw new InvalidSessionError()
  const id = (value as { id?: unknown }).id
  if (typeof id !== 'number' && typeof id !== 'string') throw new InvalidSessionError()
  return value as ManagedUser
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
const revisionKey = 'accountKitRevision'
const handleKey = 'accountKitSession'

export function createSessionGuard<User>(
  options: ManagedSessionGuardOptions<User>
): ManagedGuard<undefined> {
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
        async refresh(revision) {
          // A new session id, so a copied cookie for this session does not survive the change.
          ctx.session.regenerate()
          ctx.session.put(revisionKey, revision ?? '')
        },
      }
    },
  }
}
