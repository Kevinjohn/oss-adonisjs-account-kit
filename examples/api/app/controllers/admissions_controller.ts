import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import { InvalidInputError } from '@kevinjohn/adonisjs-account-kit'
import { AccountAdmission } from '@kevinjohn/adonisjs-account-kit/admission'
import { accountInput } from '#services/account_input'
import { admissionListValidator } from '#validators/admission'

/** Integer ids must be positive integers, so a database never receives a malformed id. */
function userIdParam(value: string): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64)
    throw new InvalidInputError('Invalid user ID')
  const id = /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(id)) throw new InvalidInputError('Invalid user ID')
  return id
}

const admission = () => app.container.make(AccountAdmission)

/**
 * The account's own admission status and request, reachable while not admitted, and the owner's
 * list and decisions. The package sends no notification: this status is how a person learns the
 * decision.
 */
export default class AdmissionsController {
  async show(ctx: HttpContext) {
    const service = await admission()
    const { decision } = await service.current(accountInput(ctx))
    return ctx.response.ok(decision)
  }

  async request(ctx: HttpContext) {
    const service = await admission()
    const record = await service.request(accountInput(ctx))
    return ctx.response.ok({ requestedAt: record.requestedAt })
  }

  async index(ctx: HttpContext) {
    const actor = await ctx.auth.getUserOrFail()
    const { status, cursor, limit } = await ctx.request.validateUsing(admissionListValidator)
    const service = await admission()
    return ctx.response.ok(await service.list({ actorId: actor.id, status, cursor, limit }))
  }

  async approve(ctx: HttpContext) {
    return this.decide(ctx, 'approve')
  }

  async reject(ctx: HttpContext) {
    return this.decide(ctx, 'reject')
  }

  async revoke(ctx: HttpContext) {
    return this.decide(ctx, 'revoke')
  }

  private async decide(ctx: HttpContext, decision: 'approve' | 'reject' | 'revoke') {
    const actor = await ctx.auth.getUserOrFail()
    const service = await admission()
    const record = await service[decision]({
      actorId: actor.id,
      userId: userIdParam(ctx.params.id),
    })
    return ctx.response.ok({ userId: record.userId, approval: record.approval })
  }
}
