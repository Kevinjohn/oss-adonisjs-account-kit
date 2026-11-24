import { lockUser } from './db.js'
import {
  E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED,
  E_ACCOUNT_KIT_NO_PASSWORD,
  E_ACCOUNT_KIT_ACTOR_NOT_FOUND,
} from './errors.js'
import { consumeSocialSensitiveProof } from './social_proofs.js'
import type { AccountUser, ResolvedConfig, SensitivePurpose, Trx, UserId } from './types.js'

/** Load a user by id, or reject the request when the user no longer exists. */
export async function requireUser(
  config: ResolvedConfig,
  id: UserId,
  trx?: Trx
): Promise<AccountUser> {
  const user = await config.users.findById(id, trx)
  if (!user) throw new E_ACCOUNT_KIT_ACTOR_NOT_FOUND()
  return user
}

interface ConfirmActorInput {
  actorId: UserId
  currentPassword?: unknown
  recentProof?: unknown
  purpose: SensitivePurpose
}

/** Lock the actor and consume the credential proof inside the same write transaction. */
export async function confirmActor(
  config: ResolvedConfig,
  trx: Trx,
  { actorId, currentPassword, recentProof, purpose }: ConfirmActorInput
): Promise<AccountUser> {
  await lockUser(trx, config, actorId)
  const actor = await requireUser(config, actorId, trx)
  if (!actor.hasPassword) {
    if (!config.enabled.includes('socialAuthentication')) throw new E_ACCOUNT_KIT_NO_PASSWORD()
    if (typeof recentProof !== 'string') throw new E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED()
    await consumeSocialSensitiveProof(trx, config, actor.id, purpose, recentProof)
    return actor
  }
  if (
    typeof currentPassword !== 'string' ||
    currentPassword.length === 0 ||
    !(await config.users.verifyPassword(actor.id, currentPassword, trx))
  )
    throw new E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED()
  return actor
}
