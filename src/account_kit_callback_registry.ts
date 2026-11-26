import { CallbackRegistry } from './callback_registry.ts'
import type { AccountKitCallbacks } from './types.ts'

/**
 * Supplies `config/account_kit.ts` callbacks from an application provider. Resolve it as
 * `account_kit.callbacks` in the provider's `boot()` and call `register` once.
 *
 * @example
 * ```ts
 * import { AccountKitCallbackRegistry } from '@kevinjohn/adonisjs-account-kit'
 * import app from '@adonisjs/core/services/app'
 *
 * const registry = await app.container.make(AccountKitCallbackRegistry)
 * registry.register(() => ({ users }))
 * ```
 */
export class AccountKitCallbackRegistry extends CallbackRegistry<AccountKitCallbacks> {
  constructor() {
    super('account_kit')
  }
}
