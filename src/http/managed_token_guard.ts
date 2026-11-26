import type { HttpContext } from '@adonisjs/core/http'
import { E_ACCOUNT_KIT_ADAPTER_CONTRACT, E_ACCOUNT_KIT_INVALID_SESSION } from '../errors.ts'
import type { UserId } from '../types.ts'
import type { ManagedGuard } from './managed_types.ts'
import type { ManagedTokenGuardOptions, ManagedTokenCredential, ManagedUser } from './guard.ts'
import { markAuthenticated, type MarkableAuthenticator } from './authenticator_mark.ts'
import {
  ManagedTokenRequestGuard,
  requireTokenIdentifierValue,
} from './managed_token_request_guard.ts'

function requireManagedUser(value: unknown): ManagedUser {
  if (!value || typeof value !== 'object') throw new E_ACCOUNT_KIT_INVALID_SESSION()
  const id = (value as { id?: unknown }).id
  if (typeof id !== 'number' && typeof id !== 'string') throw new E_ACCOUNT_KIT_INVALID_SESSION()
  return value as ManagedUser
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
  credentialForRevocation: NonNullable<
    ManagedGuard<ManagedTokenCredential>['credentialForRevocation']
  > = async (context) => {
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
