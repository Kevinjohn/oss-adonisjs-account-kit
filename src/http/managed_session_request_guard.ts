import type { HttpContext } from '@adonisjs/core/http'
import type { AuthenticationGuard } from '../types.ts'
import type { ManagedSessionGuardOptions } from './guard.ts'
import type { MarkableAuthenticator } from './authenticator_mark.ts'

export type SessionContext<User> = HttpContext & {
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
export const revisionKey = 'accountKitRevision'
export const handleKey = 'accountKitSession'

type ManagedSessionRequestGuardContract = Extract<
  AuthenticationGuard<undefined>,
  { strategy: 'session' }
>

export class ManagedSessionRequestGuard<User> implements ManagedSessionRequestGuardContract {
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
