import app from '@adonisjs/core/services/app'
import type { Trx } from '@kevinjohn/adonisjs-account-kit'
import { AccountAdmission } from '@kevinjohn/adonisjs-account-kit/admission'

/** True when the user passes every admission requirement. Resolved lazily from the container. */
export async function isAdmitted(userId: number | string, trx?: Trx): Promise<boolean> {
  const admission = await app.container.make(AccountAdmission)
  return admission.isAdmitted(userId, trx)
}
