import db from '@adonisjs/lucid/services/db'
import { notifications } from '#services/account_kit_notifications'

/** Sends one committed credential-change notice. Must be idempotent per operation ID. */
export type DeliverCredentialNotice = (
  operationId: string,
  operation: string,
  recipient: string
) => Promise<void>

/** The example's in-memory delivery, with its simulated worker interruption for tests. */
async function deliverToNotifications(operationId: string, operation: string, recipient: string) {
  await notifications.deliverCredentialNotice(operationId, operation, recipient)
  if (notifications.crashAfterOutboxSend) {
    notifications.crashAfterOutboxSend = false
    throw new Error('simulated worker interruption after idempotent delivery')
  }
}

/** Deliver committed credential-change notices and keep failed work pending for retry. */
export async function dispatchAccountKitOutbox(
  limit = 100,
  deliver: DeliverCredentialNotice = deliverToNotifications
): Promise<number> {
  const pending = await db
    .from('account_kit_outbox')
    .whereNull('sent_at')
    .orderBy('id', 'asc')
    .limit(limit)

  let delivered = 0
  for (const row of pending) {
    try {
      await deliver(row.operation_id, row.operation, row.recipient_email)
      await db
        .from('account_kit_outbox')
        .where('id', row.id)
        .whereNull('sent_at')
        .update({ sent_at: new Date(), last_error: null })
      delivered += 1
    } catch (error) {
      await db
        .from('account_kit_outbox')
        .where('id', row.id)
        .whereNull('sent_at')
        .update({ attempts: db.raw('attempts + 1'), last_error: 'delivery_failed' })
      throw new Error('Account-kit outbox delivery failed', { cause: error })
    }
  }
  return delivered
}
