// Password change: confirms the actor, sets the new password and ends older credentials.
import { randomUUID } from 'node:crypto'
import { credentialsChanged } from './authentication.js'
import { transaction } from './db.js'
import { afterCommit, finishCommitted, settleCommitted } from './effects.js'
import { InvalidInputError } from './errors.js'
import { isPasswordAllowed } from './password.js'
import { preparePassword, storePassword } from './password_hashing.js'
import { throttlerOf } from './throttle.js'
import { clearRecoveryTokens } from './credential_cleanup.js'
import { confirmActor, requireUser } from './actor_confirmation.js'
import type { ChangePasswordInput } from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'

export async function changePassword(
  deps: ServiceDependencies,
  input: ChangePasswordInput
): Promise<void> {
  if (!isPasswordAllowed(input.newPassword, deps.config.passwordPolicy))
    throw new InvalidInputError('Invalid new password')

  await throttlerOf(deps).consume('identity:user', String(input.actorId), deps.config.throttle)
  const operationId = randomUUID()
  const password = await preparePassword(deps.config.users, input.newPassword)
  const { value: user, fault } = await settleCommitted(
    transaction(deps.db, async (trx) => {
      const actor = await confirmActor(
        deps.config,
        trx,
        input.actorId,
        input.currentPassword,
        input.recentProof,
        'password_change'
      )
      await storePassword(deps.config.users, actor.id, password, trx)
      if (actor.unverifiedEmail !== null && actor.unverifiedEmail !== actor.email)
        await deps.config.users.setUnverifiedEmail(actor.id, null, trx)
      await clearRecoveryTokens(trx, actor.id, [
        'password_reset_tokens',
        'email_verification_tokens',
      ])
      const reloaded = await requireUser(deps.config, actor.id, trx)
      await credentialsChanged(trx, deps.config, reloaded, {
        operation: 'password_change',
        operationId,
        userId: reloaded.id,
      })
      return reloaded
    })
  )

  const context = { operation: 'password_change' as const, operationId, userId: user.id }
  await finishCommitted(fault, 'Credentials changed but follow-ups failed', () =>
    afterCommit(
      'Credentials changed but a follow-up failed',
      () => deps.config.onCredentialsChanged?.(user, context),
      () => deps.config.notify.passwordChanged(user, context),
      () =>
        deps.config.onLifecycleEvent?.({ type: 'password.changed', userId: user.id, operationId })
    )
  )
}
