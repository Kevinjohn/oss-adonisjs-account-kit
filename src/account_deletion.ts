// Account deletion: re-authenticate, run the application hook, delete every package row, then
// the user row, all in one transaction under the user lock.
import { randomUUID } from 'node:crypto'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { confirmActor } from './actor_confirmation.js'
import { transaction } from './db.js'
import { finishCommitted, lifecycle, postCommit, settleCommitted } from './effects.js'
import { throttlerOf, type Throttler } from './throttle.js'
import { deleteUserRows } from './user_rows.js'
import type { AccountDataInput, DeletedAccount, ResolvedConfig } from './types.js'

export async function deleteAccount(
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService; throttler?: Throttler },
  input: AccountDataInput
): Promise<void> {
  const { config } = deps
  const remove = config.users.delete
  if (!remove) throw new Error('account_kit: users.delete must be a function')
  await throttlerOf(deps).consume('identity:user', String(input.actorId), config.throttle)
  const operationId = randomUUID()
  const { value: deleted, fault } = await settleCommitted(
    transaction(deps.db, async (trx): Promise<DeletedAccount> => {
      const user = await confirmActor(
        config,
        trx,
        input.actorId,
        input.currentPassword,
        input.recentProof,
        'account_delete'
      )
      await config.onAccountDeletingTransaction?.(user, trx)
      await deleteUserRows(trx, config, user.id)
      await remove.call(config.users, user.id, trx)
      return { id: user.id, email: user.email }
    })
  )
  await finishCommitted(fault, 'Account deleted but follow-ups failed', () =>
    postCommit('Account deleted but a follow-up failed', [
      { kind: 'delivery', run: () => config.notify.accountDeleted(deleted) },
      lifecycle(config, { type: 'account.deleted', userId: deleted.id, operationId }),
    ])
  )
}
