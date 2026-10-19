import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import accountKit from 'adonisjs-account-kit/services/main'
import { accountInput } from '#middleware/account_access_middleware'

/** Credential, restriction, and verified-account gate for protected routes. */
export default class VerifiedAccountMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    await accountKit.authentication.requireActive(accountInput(ctx))
    return next()
  }
}
