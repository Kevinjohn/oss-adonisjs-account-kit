// Builds the Account Kit config from `config/account_kit.ts` and the registered callbacks.
import { configProvider } from '@adonisjs/core'
import type { ApplicationService } from '@adonisjs/core/types'
import { AccountKitCallbackConfiguration } from './account_kit_callback_configuration.ts'
import { assertObject } from './config_assert.ts'
import { resolveConfig, type defineConfig } from './config.ts'
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from './errors.ts'
import type { AccountKitCallbacks, AccountKitConfig, ResolvedConfig } from './types.ts'

function rejectDuplicateSetting(field: string): never {
  throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
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
    if (input[field] !== undefined) rejectDuplicateSetting(field)
    merged[field] = callbacks[field]
  }
  if (callbacks.mapRegistrationFields !== undefined) {
    if (input.registration?.mapFields !== undefined)
      rejectDuplicateSetting('registration.mapFields')
    merged.registration = Object.assign(Object.create(input.registration ?? null), {
      mapFields: callbacks.mapRegistrationFields,
    })
  }
  return merged as unknown as AccountKitConfig
}

/**
 * Resolves the `account_kit` config once per config value. `AccountKitProvider` registers it as a
 * container singleton, so every resolution in one application shares it.
 */
export class AccountKitConfigResolution {
  #memo?: { config: ReturnType<typeof defineConfig>; resolved: Promise<ResolvedConfig | undefined> }

  resolve(app: ApplicationService): Promise<ResolvedConfig | undefined> {
    const config = app.config.get<ReturnType<typeof defineConfig> | undefined>('account_kit')
    if (!config) return Promise.resolve(undefined)
    if (this.#memo?.config === config) return this.#memo.resolved
    const resolved = configProvider
      .resolve<ResolvedConfig>(app, config)
      .then((value) => value ?? undefined)
    this.#memo = { config, resolved }
    return resolved
  }
}

/**
 * The `account_kit` config merged with the callbacks registered through `account_kit.callbacks`,
 * with every `defineConfig` check run on the result. Undefined when the config file is missing.
 * Built once per application and config.
 */
export async function resolveAccountKitConfig(
  app: ApplicationService
): Promise<ResolvedConfig | undefined> {
  const resolution = await app.container.make(AccountKitConfigResolution)
  return resolution.resolve(app)
}

/** Completes validation after the application has registered its callbacks. */
export async function resolveRegisteredCallbacks(
  app: ApplicationService,
  input: AccountKitConfig,
  preliminary: ResolvedConfig
): Promise<ResolvedConfig> {
  const registry = await app.container.make(AccountKitCallbackConfiguration)
  const callbacks = await registry.resolve()
  if (!callbacks) {
    resolveConfig(input, false)
    return preliminary
  }
  return resolveConfig(mergeCallbacks(input, callbacks), false)
}
