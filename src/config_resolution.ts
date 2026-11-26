// Builds the Account Kit config from `config/account_kit.ts` and the registered callbacks.
import { configProvider } from '@adonisjs/core'
import type { ApplicationService } from '@adonisjs/core/types'
import { AccountKitCallbackConfiguration } from './account_kit_callback_configuration.ts'
import { assertObject } from './config_assert.ts'
import { resolveConfig, type defineConfig } from './config.ts'
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from './errors.ts'
import type { AccountKitCallbacks, AccountKitConfig, ResolvedConfig } from './types.ts'

const resolutions = new WeakMap<
  ApplicationService,
  { config: ReturnType<typeof defineConfig>; resolved: Promise<ResolvedConfig | undefined> }
>()

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
 * The `account_kit` config merged with the callbacks registered through `account_kit.callbacks`,
 * with every `defineConfig` check run on the result. Undefined when the config file is missing.
 * Built once per application and config.
 */
export function resolveAccountKitConfig(
  app: ApplicationService
): Promise<ResolvedConfig | undefined> {
  const config = app.config.get<ReturnType<typeof defineConfig> | undefined>('account_kit')
  if (!config) return Promise.resolve(undefined)
  const memo = resolutions.get(app)
  if (memo?.config === config) return memo.resolved
  const resolved = configProvider
    .resolve<ResolvedConfig>(app, config)
    .then((value) => value ?? undefined)
  resolutions.set(app, { config, resolved })
  return resolved
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
