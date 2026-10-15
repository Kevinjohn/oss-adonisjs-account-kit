import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { AccountKit } from 'adonisjs-account-kit'
import { accountInput } from '#middleware/account_access_middleware'

/** Credential, restriction, and verified-account gate for protected routes. */
export default class VerifiedAccountMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const kit = await app.container.make(AccountKit)
    await kit.authentication.requireActive(accountInput(ctx))
    return next()
  }
}
