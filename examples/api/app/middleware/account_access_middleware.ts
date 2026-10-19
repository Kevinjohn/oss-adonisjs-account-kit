import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import accountKit from 'adonisjs-account-kit/services/main'
import { accountInput } from '#services/account_input'

export { accountInput }

/** Credential and restriction gate for routes an inactive account may use. */
export default class AccountAccessMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    await accountKit.authentication.current(accountInput(ctx))
    return next()
  }
}
