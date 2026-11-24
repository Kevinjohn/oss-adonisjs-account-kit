import { E_ACCOUNT_KIT_DELIVERY, E_ACCOUNT_KIT_POST_COMMIT } from '@kevinjohn/adonisjs-account-kit'

/**
 * True when Account Kit reports a failure after it has saved the account change.
 */
export function isDeliveryFailure(error: unknown) {
  return error instanceof E_ACCOUNT_KIT_DELIVERY || error instanceof E_ACCOUNT_KIT_POST_COMMIT
}
