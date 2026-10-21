import type { HttpContext } from '@adonisjs/core/http'
import { InvalidSessionError } from '../errors.js'
import type { UserId } from '../types.js'
import type { ManagedGuard } from './managed_types.js'
import type { ManagedTokenGuardOptions, ManagedTokenCredential, ManagedUser } from './guard.js'

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
  return normalizedIdentifier((token as { identifier?: unknown }).identifier)
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
type TokenContext<User> = HttpContext & {
  auth: { use(name: string): { authenticate(): Promise<User> } }
}

export function createTokenGuard<User>(
  options: ManagedTokenGuardOptions<User>
): ManagedGuard<ManagedTokenCredential> {
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
