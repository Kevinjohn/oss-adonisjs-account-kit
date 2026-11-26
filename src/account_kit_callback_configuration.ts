import { CallbackConfiguration } from './callback_configuration.ts'
import type { AccountKitCallbacks } from './types.ts'

/**
 * Supplies `config/account_kit.ts` callbacks from an application provider. Resolve it as
 * `account_kit.callbacks` in the provider's `boot()` and call `register` once.
 *
 * @example
 * ```ts
 * import { AccountKitCallbackConfiguration } from '@kevinjohn/adonisjs-account-kit'
 * import app from '@adonisjs/core/services/app'
 *
 * const registry = await app.container.make(AccountKitCallbackConfiguration)
 * registry.register(() => ({ users }))
 * ```
 */
export class AccountKitCallbackConfiguration extends CallbackConfiguration<AccountKitCallbacks> {
  constructor() {
    super('account_kit')
  }
}
