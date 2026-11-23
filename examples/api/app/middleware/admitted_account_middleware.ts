import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { inject } from '@adonisjs/core'
import { AccountAdmission } from '@kevinjohn/adonisjs-account-kit/admission'
import { accountInput } from '#services/account_input'

/** Credential, restriction, verified-account and admission gate for protected application data. */
@inject()
export default class AdmittedAccountMiddleware {
  constructor(private readonly admission: AccountAdmission) {}

  async handle(ctx: HttpContext, next: NextFn) {
    await this.admission.require(accountInput(ctx))
    return next()
  }
}
