import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import app from '@adonisjs/core/services/app'
import { AccountAdmission } from 'adonisjs-account-kit/admission'
import { accountInput } from '#services/account_input'

/** Credential, restriction, verified-account and admission gate for protected application data. */
export default class AdmittedAccountMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const admission = await app.container.make(AccountAdmission)
    await admission.require(accountInput(ctx))
    return next()
  }
}
