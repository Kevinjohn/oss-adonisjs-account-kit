import { E_ACCOUNT_KIT_ADAPTER_CONTRACT, E_ACCOUNT_KIT_INVALID_SESSION } from '../errors.ts'
import type { AuthenticationGuard, UserId } from '../types.ts'
import type { ManagedTokenGuardOptions, ManagedTokenCredential } from './guard.ts'

export function requireTokenIdentifierValue(value: unknown): UserId {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'number' && typeof value !== 'string')
    throw new E_ACCOUNT_KIT_INVALID_SESSION()
  return value
}

type ManagedTokenRequestGuardContract = Extract<
  AuthenticationGuard<ManagedTokenCredential>,
  { strategy: 'access_tokens' }
>

export class ManagedTokenRequestGuard<User> implements ManagedTokenRequestGuardContract {
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
