// Holds the admission callbacks an application provider registers.
import { CallbackRegistry } from '../callback_registry.js'
import type { AdmissionCallbacks } from './types.js'

/**
 * Supplies `config/admission.ts` callbacks from an application provider. Resolve it as
 * `account_admission.callbacks` in the provider's `boot()` and call `register` once.
 */
export class AdmissionCallbackRegistry extends CallbackRegistry<AdmissionCallbacks> {
  constructor() {
    super('account_admission')
  }
}
