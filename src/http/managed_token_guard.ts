import type { HttpContext } from '@adonisjs/core/http'
import { E_ACCOUNT_KIT_ADAPTER_CONTRACT, E_ACCOUNT_KIT_INVALID_SESSION } from '../errors.ts'
import type { AuthenticationGuard, UserId } from '../types.ts'
import type { ManagedGuard } from './managed_types.ts'
import type { ManagedTokenGuardOptions, ManagedTokenCredential, ManagedUser } from './guard.ts'
import { markAuthenticated, type MarkableAuthenticator } from './authenticator_mark.ts'

function requireManagedUser(value: unknown): ManagedUser {
  if (!value || typeof value !== 'object') throw new E_ACCOUNT_KIT_INVALID_SESSION()
  const id = (value as { id?: unknown }).id
  if (typeof id !== 'number' && typeof id !== 'string') throw new E_ACCOUNT_KIT_INVALID_SESSION()
  return value as ManagedUser
}
function requireTokenIdentifierValue(value: unknown): UserId {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'number' && typeof value !== 'string')
    throw new E_ACCOUNT_KIT_INVALID_SESSION()
  return value
}
function requireCurrentTokenIdentifier(value: unknown): UserId {
  if (!value || typeof value !== 'object') throw new E_ACCOUNT_KIT_INVALID_SESSION()
  const token = (value as { currentAccessToken?: unknown }).currentAccessToken
  if (!token || typeof token !== 'object') throw new E_ACCOUNT_KIT_INVALID_SESSION()
  return requireTokenIdentifierValue((token as { identifier?: unknown }).identifier)
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
type TokenContext<User> = HttpContext & {
  auth: MarkableAuthenticator & { use(name: string): { authenticate(): Promise<User> } }
}

export function createTokenGuard<User>(
  options: ManagedTokenGuardOptions<User>
): ManagedGuard<ManagedTokenCredential> {
  return new ManagedTokenGuard(options)
}

type ManagedTokenRequestGuardContract = Extract<
  AuthenticationGuard<ManagedTokenCredential>,
  { strategy: 'access_tokens' }
>

class ManagedTokenGuard<User> implements ManagedGuard<ManagedTokenCredential> {
  #options: ManagedTokenGuardOptions<User>

  strategy = 'access_tokens' as const
  name: string

  constructor(options: ManagedTokenGuardOptions<User>) {
    this.#options = options
    this.name = options.name
  }

  publicCredential: NonNullable<ManagedGuard<ManagedTokenCredential>['publicCredential']> = (
    credential
  ) => {
    if (typeof credential.value !== 'string' || !credential.value)
      throw new E_ACCOUNT_KIT_ADAPTER_CONTRACT('Token guard did not return a bearer value')
    return credential.value
  }
  current: ManagedGuard<ManagedTokenCredential>['current'] = async (context) => {
    const auth = (context as TokenContext<User>).auth
    const user = await authenticate(auth.use(this.#options.name))
    await markAuthenticated(auth, this.#options.name)
    return { userId: requireManagedUser(user).id, tokenId: requireCurrentTokenIdentifier(user) }
  }
  logoutCredential: NonNullable<ManagedGuard<ManagedTokenCredential>['logoutCredential']> = async (
    context
  ) => {
    const user = await authenticate((context as TokenContext<User>).auth.use(this.#options.name))
    return {
      userId: requireManagedUser(user).id,
      identifier: requireCurrentTokenIdentifier(user),
    }
  }
  forRequest: ManagedGuard<ManagedTokenCredential>['forRequest'] = (_context) => {
    return new ManagedTokenRequestGuard(this.#options)
  }
}

class ManagedTokenRequestGuard<User> implements ManagedTokenRequestGuardContract {
  #options: ManagedTokenGuardOptions<User>

  strategy = 'access_tokens' as const
  name: string

  constructor(options: ManagedTokenGuardOptions<User>) {
    this.#options = options
    this.name = options.name
  }

  /** @throws {AggregateError} If token issuance and deletion both fail. */
  establish: ManagedTokenRequestGuardContract['establish'] = async (
    userId,
    abilities,
    expiresIn,
    issue
  ) => {
    const model = await this.#options.loadUser()
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
    if (!token || typeof token !== 'object')
      throw new E_ACCOUNT_KIT_ADAPTER_CONTRACT('Token guard did not return a token')
    let identifier: UserId
    try {
      identifier = requireTokenIdentifierValue(token.identifier)
    } catch (error) {
      // An invalid identifier cannot safely identify a token for cleanup.
      throw new E_ACCOUNT_KIT_ADAPTER_CONTRACT('Token guard did not return a token identifier', {
        cause: error,
      })
    }
    try {
      if (!token.value || typeof token.value.release !== 'function')
        throw new E_ACCOUNT_KIT_ADAPTER_CONTRACT('Token guard did not return a bearer value')
      const value = token.value.release()
      if (typeof value !== 'string' || !value)
        throw new E_ACCOUNT_KIT_ADAPTER_CONTRACT('Token guard did not return a bearer value')
      return { userId, identifier, value }
    } catch (error) {
      try {
        await model.accessTokens.delete(user, token.identifier)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Token issuance failed and cleanup failed')
      }
      throw error
    }
  }
  terminate: ManagedTokenRequestGuardContract['terminate'] = async (credential) => {
    if (!credential) return
    const model = await this.#options.loadUser()
    await model.accessTokens.delete(
      await model.findOrFail(credential.userId),
      credential.identifier
    )
  }
}
