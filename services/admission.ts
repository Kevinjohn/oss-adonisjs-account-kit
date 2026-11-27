import app from '@adonisjs/core/services/app'
import type { AccountAdmission } from '../src/admission/service.ts'

let accountAdmission: AccountAdmission
await app.booted(async () => {
  accountAdmission = await app.container.make('account_admission')
})
export { accountAdmission as default }
