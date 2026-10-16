import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { AccountKit, InvalidInputError } from 'adonisjs-account-kit'
import { accountInput } from '#middleware/account_access_middleware'
import { requiredString } from '#services/social_request'

function identityId(value: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new InvalidInputError('Invalid identity ID')
  return id
}

export default class SocialIdentitiesController {
  async provePassword(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    const kit = await app.container.make(AccountKit)
    const proof = await kit.socialAuthentication.provePassword({
      current: accountInput(ctx),
      password: requiredString(ctx.request.input('password'), 'password'),
      purpose: ctx.request.input('purpose'),
    })
    return ctx.response.ok({ proof })
  }

  async unlink(ctx: HttpContext) {
    const kit = await app.container.make(AccountKit)
    await kit.socialAuthentication.unlink({
      current: accountInput(ctx),
      identityId: identityId(ctx.params.id),
      proof: requiredString(ctx.request.input('proof'), 'proof'),
    })
    return ctx.response.noContent()
  }
}
