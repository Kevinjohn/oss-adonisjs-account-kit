import app from '@adonisjs/core/services/app'
import type { AdmissionCallbackConfiguration } from '../src/admission/callback_configuration.ts'

let admissionCallbacks: AdmissionCallbackConfiguration
await app.booted(async () => {
  admissionCallbacks = await app.container.make('account_admission.callbacks')
})
export { admissionCallbacks as default }
