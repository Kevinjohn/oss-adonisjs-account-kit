import { DeliveryError, PostCommitError } from 'adonisjs-account-kit'

/**
 * True when Account Kit saved the change but could not send the email that goes with it.
 */
export function isDeliveryFailure(error: unknown) {
  return error instanceof DeliveryError || error instanceof PostCommitError
}
