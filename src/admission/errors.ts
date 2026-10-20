// Errors the admission module throws; `accountErrorResponse` maps them like core errors.
import { AccountKitError } from '../errors.js'
import type { AdmissionDecision } from './types.js'

/**
 * `require` ran for a person who is not admitted. `decision` says which requirement is unmet;
 * return it so the application can explain what is missing.
 */
export class AdmissionRequiredError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_ADMISSION_REQUIRED'
  static status = 403
  /** The decision that refused the person. */
  readonly decision: AdmissionDecision

  constructor(decision: AdmissionDecision) {
    super('Admission is required')
    this.decision = decision
  }
}

/** An approve, reject or revoke that the current approval state does not allow. */
export class AdmissionDecisionError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_ADMISSION_DECISION'
  static status = 409
}
