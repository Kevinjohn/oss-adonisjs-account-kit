import db from '@adonisjs/lucid/services/db'
import { notifications } from '#services/account_kit_notifications'

/** Deliver committed credential-change notices and keep failed work pending for retry. */
export async function dispatchAccountKitOutbox(limit = 100): Promise<number> {
  const pending = await db
    .from('account_kit_outbox')
    .whereNull('sent_at')
    .orderBy('id', 'asc')
    .limit(limit)

  let delivered = 0
  for (const row of pending) {
    try {
      await notifications.deliverCredentialNotice(
        row.operation_id,
        row.operation,
        row.recipient_email
      )
      if (notifications.crashAfterOutboxSend) {
        notifications.crashAfterOutboxSend = false
        throw new Error('simulated worker interruption after idempotent delivery')
      }
      await db
        .from('account_kit_outbox')
        .where('id', row.id)
        .whereNull('sent_at')
        .update({ sent_at: new Date(), last_error: null })
      delivered += 1
    } catch {
      await db
        .from('account_kit_outbox')
        .where('id', row.id)
        .whereNull('sent_at')
        .increment('attempts', 1)
      await db
        .from('account_kit_outbox')
        .where('id', row.id)
        .whereNull('sent_at')
        .update({ last_error: 'delivery_failed' })
      throw new Error('Account-kit outbox delivery failed')
    }
  }
  return delivered
}
