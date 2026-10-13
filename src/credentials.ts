import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { lockUser, transaction } from './db.js'
import {
  IdentityNotConfirmedError,
  InvalidInputError,
  NoPasswordError,
  PostCommitError,
} from './errors.js'
import { consume } from './throttle.js'
import type { CredentialsChangePasswordInput, ResolvedConfig } from './types.js'

export async function changePassword(
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService },
  input: CredentialsChangePasswordInput
): Promise<void> {
  if (
    typeof input.newPassword !== 'string' ||
    input.newPassword.length < 8 ||
    input.newPassword.length > 255
  )
    throw new InvalidInputError('Invalid new password')

  await consume(deps.limiter, 'identity:user', String(input.actorId), deps.config.throttle)
  const user = await transaction(deps.db, async (trx) => {
    await lockUser(trx, input.actorId)
    const actor = await deps.config.users.findById(input.actorId, trx, { forUpdate: true })
    if (!actor) throw new InvalidInputError('Unknown actor')
    if (!actor.hasPassword) throw new NoPasswordError()
    if (
      typeof input.currentPassword !== 'string' ||
      input.currentPassword.length === 0 ||
      !(await deps.config.users.verifyPassword(actor.id, input.currentPassword, trx))
    )
      throw new IdentityNotConfirmedError()

    await deps.config.users.setPassword(actor.id, input.newPassword, trx)
    await trx.from('account_recovery_tokens').where('user_id', actor.id).delete()
    await trx.from('account_email_changes').where('user_id', actor.id).delete()
    const reloaded = await deps.config.users.findById(actor.id, trx)
    if (!reloaded) throw new InvalidInputError('Unknown actor')
    return reloaded
  })

  try {
    await deps.config.onCredentialsChanged?.(user)
  } catch (cause) {
    throw new PostCommitError('Credentials changed but the callback failed', { cause })
  }
}
