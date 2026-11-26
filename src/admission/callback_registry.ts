// Holds the admission callbacks an application provider registers.
import { CallbackRegistry } from '../callback_registry.ts'
import type { AdmissionCallbacks } from './types.ts'

/**
 * Supplies `config/admission.ts` callbacks from an application provider. Resolve it as
 * `account_admission.callbacks` in the provider's `boot()` and call `register` once.
 *
 * @example
 * ```ts
 * import { AdmissionCallbackRegistry } from '@kevinjohn/adonisjs-account-kit/admission'
 * import app from '@adonisjs/core/services/app'
 *
 * const registry = await app.container.make(AdmissionCallbackRegistry)
 * registry.register(() => ({ onAdmissionEvent }))
 * ```
 */
export class AdmissionCallbackRegistry extends CallbackRegistry<AdmissionCallbacks> {
  constructor() {
    super('account_admission')
  }
}
