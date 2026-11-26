import app from '@adonisjs/core/services/app'
import type { AccountKit } from '../src/account_kit.ts'

let accountKit: AccountKit
await app.booted(async () => {
  accountKit = await app.container.make('account_kit.manager')
})
export { accountKit as default }
