// Builds the Account Kit config from `config/account_kit.ts` and the registered callbacks.
import type { ApplicationService } from '@adonisjs/core/types'
import { AccountKitCallbackRegistry } from './callback_registry.js'
import { assertObject } from './config_assert.js'
import { configInputs, resolveConfig } from './config.js'
import { InvalidConfigurationError } from './errors.js'
import type { AccountKitCallbacks, AccountKitConfig, ResolvedConfig } from './types.js'

const resolutions = new WeakMap<
  ApplicationService,
  { config: ResolvedConfig; resolved: Promise<ResolvedConfig> }
>()

function bothPlaces(field: string): never {
  throw new InvalidConfigurationError(
    field,
    `account_kit: ${field} is set in both config/account_kit.ts and the registered callbacks`
  )
}

/** The config with the callbacks added. The input stays the prototype, so nothing else changes. */
function mergeCallbacks(input: AccountKitConfig, callbacks: AccountKitCallbacks): AccountKitConfig {
  assertObject(callbacks, 'callbacks')
  const merged: Record<string, unknown> = Object.create(input)
  for (const field of [
    'users',
    'authorize',
    'onInvitationAccepted',
    'onCredentialsChangedTransaction',
    'onAccountDeletingTransaction',
  ] as const) {
    if (callbacks[field] === undefined) continue
    if (input[field] !== undefined) bothPlaces(field)
    merged[field] = callbacks[field]
  }
  if (callbacks.mapRegistrationFields !== undefined) {
    if (input.registration?.mapFields !== undefined) bothPlaces('registration.mapFields')
    merged.registration = Object.assign(Object.create(input.registration ?? null), {
      mapFields: callbacks.mapRegistrationFields,
    })
  }
  return merged as unknown as AccountKitConfig
}

/**
 * The `account_kit` config merged with the callbacks registered through `account_kit.callbacks`,
 * with every `defineConfig` check run on the result. Undefined when the config file is missing.
 * Built once per application and config.
 */
export function resolveAccountKitConfig(
  app: ApplicationService
): Promise<ResolvedConfig | undefined> {
  const config = app.config.get<ResolvedConfig | undefined>('account_kit')
  if (!config) return Promise.resolve(undefined)
  const memo = resolutions.get(app)
  if (memo?.config === config) return memo.resolved
  const resolved = (async () => {
    const registry = await app.container.make(AccountKitCallbackRegistry)
    const callbacks = await registry.resolve()
    const input = configInputs.get(config)
    // A config `defineConfig` did not build is used as it is.
    if (!input) return config
    if (!callbacks) {
      // Runs the checks `defineConfig` deferred; the config it returned stays the one in use.
      resolveConfig(input, false)
      return config
    }
    return resolveConfig(mergeCallbacks(input, callbacks), false)
  })()
  resolutions.set(app, { config, resolved })
  return resolved
}
