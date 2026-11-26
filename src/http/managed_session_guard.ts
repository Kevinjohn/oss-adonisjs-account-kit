import type { HttpContext } from '@adonisjs/core/http'
import { E_ACCOUNT_KIT_INVALID_SESSION } from '../errors.ts'
import type { AuthenticationGuard } from '../types.ts'
import type { ManagedGuard } from './managed_types.ts'
import type { ManagedSessionGuardOptions, ManagedUser } from './guard.ts'
import { assertManagedSessionStore } from './session_store_protection.ts'
import { markAuthenticated, type MarkableAuthenticator } from './authenticator_mark.ts'

function requireManagedUser(value: unknown): ManagedUser {
  if (!value || typeof value !== 'object') throw new E_ACCOUNT_KIT_INVALID_SESSION()
  const id = (value as { id?: unknown }).id
  if (typeof id !== 'number' && typeof id !== 'string') throw new E_ACCOUNT_KIT_INVALID_SESSION()
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
      throw new E_ACCOUNT_KIT_INVALID_SESSION()
    throw error
  }
}
type SessionContext<User> = HttpContext & {
  auth: MarkableAuthenticator & {
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
  return new ManagedSessionGuard(options)
}

type ManagedSessionRequestGuardContract = Extract<
  AuthenticationGuard<undefined>,
  { strategy: 'session' }
>

class ManagedSessionGuard<User> implements ManagedGuard<undefined> {
  #options: ManagedSessionGuardOptions<User>

  strategy = 'session' as const
  name: string

  constructor(options: ManagedSessionGuardOptions<User>) {
    this.#options = options
    this.name = options.name
  }

  current: ManagedGuard<undefined>['current'] = async (context) => {
    const ctx = context as SessionContext<User>
    assertManagedSessionStore(ctx)
    const user = await authenticate(ctx.auth.use(this.#options.name))
    await markAuthenticated(ctx.auth, this.#options.name)
    const stored = ctx.session.get(revisionKey)
    if (stored !== undefined && typeof stored !== 'string')
      throw new E_ACCOUNT_KIT_INVALID_SESSION()
    const handle = ctx.session.get(handleKey)
    if (handle !== undefined && typeof handle !== 'string')
      throw new E_ACCOUNT_KIT_INVALID_SESSION()
    return {
      userId: requireManagedUser(user).id,
      ...(stored === undefined ? {} : { revision: stored === '' ? null : stored }),
      ...(handle ? { sessionHandle: handle } : {}),
    }
  }
  forRequest: ManagedGuard<undefined>['forRequest'] = (context) => {
    const ctx = context as SessionContext<User>
    assertManagedSessionStore(ctx)
    return new ManagedSessionRequestGuard(this.#options, ctx)
  }
}

class ManagedSessionRequestGuard<User> implements ManagedSessionRequestGuardContract {
  #options: ManagedSessionGuardOptions<User>
  #context: SessionContext<User>

  strategy = 'session' as const
  name: string

  constructor(options: ManagedSessionGuardOptions<User>, context: SessionContext<User>) {
    this.#options = options
    this.#context = context
    this.name = options.name
  }

  establish: ManagedSessionRequestGuardContract['establish'] = async (userId, revision, handle) => {
    const model = await this.#options.loadUser()
    this.#context.session.regenerate()
    await this.#context.auth.use(this.#options.name).login(await model.findOrFail(userId))
    this.#context.session.put(revisionKey, revision ?? '')
    if (handle) this.#context.session.put(handleKey, handle)
    return undefined
  }
  terminate: ManagedSessionRequestGuardContract['terminate'] = async () => {
    await this.#context.auth.use(this.#options.name).logout()
    this.#context.session.clear()
    this.#context.session.regenerate()
  }
  previousHandle: NonNullable<ManagedSessionRequestGuardContract['previousHandle']> = () => {
    const handle = this.#context.session.get(handleKey)
    return typeof handle === 'string' && handle !== '' ? handle : undefined
  }
  refresh: NonNullable<ManagedSessionRequestGuardContract['refresh']> = async (revision) => {
    // A new session id, so a copied cookie for this session does not survive the change.
    this.#context.session.regenerate()
    this.#context.session.put(revisionKey, revision ?? '')
  }
}
