// Removes a deleted account's admission state inside the deletion transaction.
import type { AccountUser, Trx } from '../types.js'
import { admissionTable } from './rows.js'

type AccountDeleting = (user: AccountUser, trx: Trx) => Promise<void>

/**
 * Returns an `onAccountDeletingTransaction` callback that deletes the user's admission row and
 * clears them as the approver of other rows, then runs `next`. It does not rely on foreign-key
 * cascades, which a custom schema may lack.
 */
export function withAdmissionCleanup(next?: AccountDeleting): AccountDeleting {
  return async (user, trx) => {
    await trx.from(admissionTable).where('user_id', user.id).delete()
    await trx
      .from(admissionTable)
      .where('approval_actor_id', user.id)
      .update({ approval_actor_id: null })
    if (next) await next(user, trx)
  }
}
