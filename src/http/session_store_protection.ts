import { configProvider } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import type { ConfigProvider } from '@adonisjs/core/types'
import { InvalidArgumentsException } from '@adonisjs/core/exceptions'

import type {
  ManagedSessionConfiguration,
  ManagedSessionStoreFactory,
} from './session_store_types.ts'

export type {
  ManagedSessionConfiguration,
  ManagedSessionStoreFactory,
} from './session_store_types.ts'

const setupError =
  'Managed session authentication requires protectManagedSessionConfig with a revocable server-side store'

/**
 * Resolve the session configuration before AdonisJS creates SessionMiddleware. The selected
 * factory is called exactly once by AdonisJS; its actual result is checked and returned.
 *
 * @example
 * ```ts
 * import { protectManagedSessionConfig } from '@kevinjohn/adonisjs-account-kit/http'
 * import { isTrustedRevocableSessionStore } from '#services/session_store_policy'
 *
 * export default protectManagedSessionConfig(sessionConfig, {
 *   verifyStore: isTrustedRevocableSessionStore,
 * })
 * ```
 */
export function protectManagedSessionConfig<Config extends ManagedSessionConfiguration>(
  provider: ConfigProvider<Config>,
  options: {
    /** Attest that the actual non-cookie store revokes a destroyed session ID. */
    verifyStore(store: unknown): boolean
  }
): ConfigProvider<Config> {
  return configProvider.create(async (app) => {
    if (typeof options.verifyStore !== 'function') throw new InvalidArgumentsException(setupError)
    // The session package is optional until this session-only helper is resolved.
    const { stores } = await import('@adonisjs/session')
    const config = await configProvider.resolve<Config>(app, provider)
    const cookieFactory = await configProvider.resolve<ManagedSessionStoreFactory>(
      app,
      stores.cookie()
    )
    if (!config || !cookieFactory) throw new InvalidArgumentsException(setupError)
    const selected = config.stores[config.store]
    if (typeof selected !== 'function') throw new InvalidArgumentsException(setupError)
    return new ProtectedSessionConfig(
      config,
      selected,
      cookieFactory,
      options.verifyStore
    ) as unknown as Config
  })
}

/**
 * The resolved session config with its selected store replaced by a checked factory. It records
 * each request whose store that factory checked, so the managed guard can fail closed.
 */
class ProtectedSessionConfig implements ManagedSessionConfiguration {
  declare store: string
  declare stores: Record<string, ManagedSessionStoreFactory>
  readonly #verified = new WeakMap<object, object>()
  readonly #createVerifiedStore: ManagedSessionStoreFactory

  constructor(
    config: ManagedSessionConfiguration,
    selected: ManagedSessionStoreFactory,
    cookieFactory: ManagedSessionStoreFactory,
    verifyStore: (store: unknown) => boolean
  ) {
    Object.assign(this, config)
    this.#createVerifiedStore = (context, sessionConfig) => {
      // Native SessionCollection passes null; it needs the same store check but no request marker.
      const httpContext = context && typeof context === 'object' ? context : null
      if (httpContext) this.#verified.delete(httpContext)
      const store = selected(context, sessionConfig)
      const nativeCookie = cookieFactory(context, sessionConfig)
      const cookieConstructor =
        nativeCookie && typeof nativeCookie === 'object'
          ? Object.getPrototypeOf(nativeCookie)?.constructor
          : undefined
      if (typeof cookieConstructor !== 'function') throw new InvalidArgumentsException(setupError)
      if (store instanceof cookieConstructor || verifyStore(store) !== true)
        throw new InvalidArgumentsException(
          'Managed session authentication requires a revocable server-side store'
        )
      if (httpContext) this.#verified.set(httpContext, sessionConfig)
      return store
    }
    this.stores = { ...config.stores, [config.store]: this.#createVerifiedStore }
  }

  /** Whether this request's session was built from this config through its checked factory. */
  static verified(context: object, config: unknown): boolean {
    return (
      config instanceof ProtectedSessionConfig &&
      config.#verified.get(context) === config &&
      config.stores[config.store] === config.#createVerifiedStore
    )
  }
}

/** Fail closed if the actual request Session did not use the protected selected factory. */
export function assertManagedSessionStore(
  context: HttpContext & { session?: { config?: unknown } }
) {
  if (!ProtectedSessionConfig.verified(context, context.session?.config))
    throw new InvalidArgumentsException(setupError)
}
