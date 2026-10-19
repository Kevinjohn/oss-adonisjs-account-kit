import { lockUser } from './db.js'
import { IdentityNotConfirmedError, InvalidInputError, NoPasswordError } from './errors.js'
import { consumeSocialSensitiveProof } from './social_proofs.js'
import type { AccountUser, ResolvedConfig, SensitivePurpose, Trx, UserId } from './types.js'

/** Lock the actor and consume the credential proof inside the same write transaction. */
export async function confirmActor(
  config: ResolvedConfig,
  trx: Trx,
  actorId: UserId,
  currentPassword: unknown,
  recentProof: unknown,
  purpose: SensitivePurpose
): Promise<AccountUser> {
  await lockUser(trx, config, actorId)
  const actor = await config.users.findById(actorId, trx)
  if (!actor) throw new InvalidInputError('Unknown actor')
  if (!actor.hasPassword) {
    if (!config.enabled.includes('socialAuthentication')) throw new NoPasswordError()
    if (typeof recentProof !== 'string') throw new IdentityNotConfirmedError()
    await consumeSocialSensitiveProof(trx, config, actor.id, purpose, recentProof)
    return actor
  }
  if (
    typeof currentPassword !== 'string' ||
    currentPassword.length === 0 ||
    !(await config.users.verifyPassword(actor.id, currentPassword, trx))
  )
    throw new IdentityNotConfirmedError()
  return actor
}
