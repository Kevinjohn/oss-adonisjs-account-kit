import type { HttpContext } from '@adonisjs/core/http'
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

export async function decideAdmission(ctx: HttpContext, decision: 'approve' | 'reject' | 'revoke') {
  const actor = await ctx.auth.getUserOrFail()
  const service = await app.container.make(AccountAdmission)
  const record = await service[decision]({ actorId: actor.id, userId: userIdParam(ctx.params.id) })
  return { userId: record.userId, approval: record.approval }
}
