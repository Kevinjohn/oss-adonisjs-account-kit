import { DeliveryError, PostCommitError } from 'adonisjs-account-kit'

/**
 * True when Account Kit reports a failure after it has saved the account change.
 */
export function isDeliveryFailure(error: unknown) {
  return error instanceof DeliveryError || error instanceof PostCommitError
}
