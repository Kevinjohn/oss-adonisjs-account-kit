// Holds the admission callbacks an application provider registers.
import { CallbackConfiguration } from '../callback_configuration.ts'
import type { AdmissionCallbacks } from './types.ts'

/**
 * Supplies `config/admission.ts` callbacks from an application provider. Resolve it by class
 * in the provider's `boot()` and call `register` once.
 *
 * @example
 * ```ts
 * import { AdmissionCallbackConfiguration } from '@kevinjohn/adonisjs-account-kit/admission'
 * import app from '@adonisjs/core/services/app'
 *
 * const registry = await app.container.make(AdmissionCallbackConfiguration)
 * registry.register(() => ({ onAdmissionNotification }))
 * ```
 */
export class AdmissionCallbackConfiguration extends CallbackConfiguration<AdmissionCallbacks> {
  constructor() {
    super('account_admission')
  }
}
