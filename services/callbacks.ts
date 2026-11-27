import app from '@adonisjs/core/services/app'
import type { AccountKitCallbackConfiguration } from '../src/account_kit_callback_configuration.ts'

let accountKitCallbacks: AccountKitCallbackConfiguration
await app.booted(async () => {
  accountKitCallbacks = await app.container.make('account_kit.callbacks')
})
export { accountKitCallbacks as default }
