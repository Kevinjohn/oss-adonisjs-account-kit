import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { AccountAdmission } from '@kevinjohn/adonisjs-account-kit/admission'
import { accountInput } from '#services/account_input'
import { admissionListValidator, userIdParam } from '#validators/admission'
import { AdmissionDecisionsService } from '#services/admission_decisions_service'

/**
 * The account's own admission status and request, reachable while not admitted, and the owner's
 * list and decisions. The package sends no notification: this status is how a person learns the
 * decision.
 */
@inject()
export default class AdmissionsController {
  #admission: AccountAdmission
  #decisions: AdmissionDecisionsService

  constructor(admission: AccountAdmission, decisions: AdmissionDecisionsService) {
    this.#admission = admission
    this.#decisions = decisions
  }

  async show({ auth, session, response }: HttpContext) {
    const { decision } = await this.#admission.current(accountInput({ auth, session }))
    return response.ok(decision)
  }

  async request({ auth, session, response }: HttpContext) {
    const record = await this.#admission.request(accountInput({ auth, session }))
    return response.ok({ requestedAt: record.requestedAt })
  }

  async index({ auth, request, response }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const { status, cursor, limit } = await request.validateUsing(admissionListValidator)
    return response.ok(await this.#admission.list({ actorId: actor.id, status, cursor, limit }))
  }

  async approve({ auth, params, response }: HttpContext) {
    const actor = auth.getUserOrFail()
    const userId = userIdParam(params.id)
    return response.ok(await this.#decisions.decide(actor.id, userId, 'approve'))
  }

  async reject({ auth, params, response }: HttpContext) {
    const actor = auth.getUserOrFail()
    const userId = userIdParam(params.id)
    return response.ok(await this.#decisions.decide(actor.id, userId, 'reject'))
  }

  async revoke({ auth, params, response }: HttpContext) {
    const actor = auth.getUserOrFail()
    const userId = userIdParam(params.id)
    return response.ok(await this.#decisions.decide(actor.id, userId, 'revoke'))
  }
}
