import { inject } from '@adonisjs/core'
import { AccountAdmission } from '@kevinjohn/adonisjs-account-kit/admission'

@inject()
export class AdmissionDecisionsService {
  #admission: AccountAdmission

  constructor(admission: AccountAdmission) {
    this.#admission = admission
  }

  async decide(
    actorId: number | string,
    userId: number | string,
    transition: 'approve' | 'reject' | 'revoke'
  ) {
    const record = await this.#admission[transition]({ actorId, userId })
    return { userId: record.userId, approval: record.approval }
  }
}
