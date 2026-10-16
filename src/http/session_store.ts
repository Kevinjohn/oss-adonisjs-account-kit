import { configProvider } from '@adonisjs/core/config'
import type { HttpContext } from '@adonisjs/core/http'
import type { ConfigProvider } from '@adonisjs/core/types'

type StoreFactory = (context: HttpContext, config: never) => unknown
type SessionConfiguration = {
  store: string
  stores: Record<string, StoreFactory>
}

const verifiedRequests = new WeakMap<object, { config: object; factory: StoreFactory }>()
const setupError =
  'Managed session authentication requires protectManagedSessionConfig with a revocable server-side store'

/**
 * Resolve the session configuration before Adonis creates SessionMiddleware. The selected
 * factory is called exactly once by Adonis; its actual result is checked and returned.
 */
export function protectManagedSessionConfig<Config extends SessionConfiguration>(
  provider: ConfigProvider<Config>,
  options: {
    /** Attest that the actual non-cookie store revokes a destroyed session ID. */
    verifyStore(store: unknown): boolean
  }
): ConfigProvider<Config> {
  return configProvider.create(async (app) => {
    if (typeof options.verifyStore !== 'function') throw new Error(setupError)
    // The session package is optional until this session-only helper is resolved.
    const { stores } = await import('@adonisjs/session')
    const config = await configProvider.resolve<Config>(app, provider)
    const cookieFactory = await configProvider.resolve<StoreFactory>(app, stores.cookie())
    if (!config || !cookieFactory) throw new Error(setupError)
    const selected = config.stores[config.store]
    if (typeof selected !== 'function') throw new Error(setupError)

    const verifiedFactory: StoreFactory = (context, sessionConfig) => {
      // Native SessionCollection passes null; it needs the same store check but no request marker.
      const httpContext = context && typeof context === 'object' ? context : null
      if (httpContext) verifiedRequests.delete(httpContext)
      const store = selected(context, sessionConfig)
      const nativeCookie = cookieFactory(context, sessionConfig)
      const cookieConstructor =
        nativeCookie && typeof nativeCookie === 'object'
          ? Object.getPrototypeOf(nativeCookie)?.constructor
          : undefined
      if (typeof cookieConstructor !== 'function') throw new Error(setupError)
      if (store instanceof cookieConstructor || options.verifyStore(store) !== true)
        throw new Error('Managed session authentication requires a revocable server-side store')
      if (httpContext)
        verifiedRequests.set(httpContext, { config: sessionConfig, factory: verifiedFactory })
      return store
    }
    config.stores[config.store] = verifiedFactory
    return config
  })
}

/** Fail closed if the actual request Session did not use the protected selected factory. */
export function assertManagedSessionStore(
  context: HttpContext & { session?: { config?: unknown } }
) {
  const marker = verifiedRequests.get(context)
  const config = context.session?.config
  if (
    !marker ||
    !config ||
    config !== marker.config ||
    typeof config !== 'object' ||
    !('store' in config) ||
    !('stores' in config) ||
    typeof config.store !== 'string' ||
    !config.stores ||
    typeof config.stores !== 'object' ||
    (config.stores as Record<string, unknown>)[config.store] !== marker.factory
  )
    throw new Error(setupError)
}
