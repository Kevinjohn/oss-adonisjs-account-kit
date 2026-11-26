import { E_ACCOUNT_KIT_INVALID_SESSION } from '../errors.ts'
import type { ManagedGuard } from './managed_types.ts'
import type { ManagedSessionGuardOptions, ManagedUser } from './guard.ts'
import { assertManagedSessionStore } from './session_store_protection.ts'
import { markAuthenticated } from './authenticator_mark.ts'
import {
  ManagedSessionRequestGuard,
  handleKey,
  revisionKey,
  type SessionContext,
} from './managed_session_request_guard.ts'

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
export function createSessionGuard<User>(
  options: ManagedSessionGuardOptions<User>
): ManagedGuard<undefined> {
  return new ManagedSessionGuard(options)
}

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
