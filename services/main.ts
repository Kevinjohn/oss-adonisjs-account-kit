import app from '@adonisjs/core/services/app'
import { AccountKit } from '../src/account_kit.js'

let accountKit: AccountKit
await app.booted(async () => {
  accountKit = await app.container.make(AccountKit)
})
export { accountKit as default }
