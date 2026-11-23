import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { AccountAdmission } from '@kevinjohn/adonisjs-account-kit/admission'
import { accountInput } from '#services/account_input'
import { admissionListValidator, userIdParam } from '#validators/admission'

/**
 * The account's own admission status and request, reachable while not admitted, and the owner's
 * list and decisions. The package sends no notification: this status is how a person learns the
 * decision.
 */
@inject()
export default class AdmissionsController {
  constructor(private readonly admission: AccountAdmission) {}

  async show(ctx: HttpContext) {
    const { decision } = await this.admission.current(accountInput(ctx))
    return ctx.response.ok(decision)
  }

  async request(ctx: HttpContext) {
    const record = await this.admission.request(accountInput(ctx))
    return ctx.response.ok({ requestedAt: record.requestedAt })
  }

  async index(ctx: HttpContext) {
    const actor = await ctx.auth.getUserOrFail()
    const { status, cursor, limit } = await ctx.request.validateUsing(admissionListValidator)
    return ctx.response.ok(await this.admission.list({ actorId: actor.id, status, cursor, limit }))
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

  private async decide(ctx: HttpContext, transition: 'approve' | 'reject' | 'revoke') {
    const actor = await ctx.auth.getUserOrFail()
    const userId = userIdParam(ctx.params.id)
    const record = await this.admission[transition]({ actorId: actor.id, userId })
    return ctx.response.ok({ userId: record.userId, approval: record.approval })
  }
}
