import type { AccountUser, Trx } from 'adonisjs-account-kit'

export async function onCredentialsChangedTransaction(
  user: AccountUser,
  context: { operation: string; operationId: string },
  trx: Trx
) {
  if (context.operation !== 'password_reset' && context.operation !== 'password_change') return

  await trx.table('account_kit_outbox').insert({
    user_id: user.id,
    operation: context.operation,
    operation_id: context.operationId,
    recipient_email: user.email,
    created_at: new Date(),
  })
}
