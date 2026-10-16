import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { accountInput } from '#middleware/account_access_middleware'

export default class ProfileController {
  async show(ctx: HttpContext) {
    const input = accountInput(ctx)
    const kit = await app.container.make(AccountKit)
    return ctx.serialize(await kit.authentication.current(input))
  }
}
