import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import { AccountAdmission } from '@kevinjohn/adonisjs-account-kit/admission'
import { accountInput } from '#services/account_input'
import { admissionListValidator } from '#validators/admission'
import { decideAdmission } from '#services/admission_decision'

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
    return ctx.response.ok(await decideAdmission(ctx, 'approve'))
  }

  async reject(ctx: HttpContext) {
    return ctx.response.ok(await decideAdmission(ctx, 'reject'))
  }

  async revoke(ctx: HttpContext) {
    return ctx.response.ok(await decideAdmission(ctx, 'revoke'))
  }
}
