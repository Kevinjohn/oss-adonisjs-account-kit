import app from '@adonisjs/core/services/app'
import { InvalidInputError } from '@kevinjohn/adonisjs-account-kit'
import { AccountAdmission } from '@kevinjohn/adonisjs-account-kit/admission'
/** Integer ids must be positive integers, so a database never receives a malformed id. */
function userIdParam(value: string): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64)
    throw new InvalidInputError('Invalid user ID')
  const id = /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(id)) throw new InvalidInputError('Invalid user ID')
  return id
}

/**
 * Records an owner's admission decision for one user, after validating the user ID from the
 * route, and returns the user's new approval state.
 */
export async function decideAdmission(input: {
  actorId: number | string
  userId: string
  transition: 'approve' | 'reject' | 'revoke'
}) {
  const service = await app.container.make(AccountAdmission)
  const record = await service[input.transition]({
    actorId: input.actorId,
    userId: userIdParam(input.userId),
  })
  return { userId: record.userId, approval: record.approval }
}
