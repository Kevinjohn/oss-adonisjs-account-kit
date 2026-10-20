import type { HttpContext } from '@adonisjs/core/http'
import { InvalidInputError } from 'adonisjs-account-kit'
import accountKit from 'adonisjs-account-kit/services/main'
import { accountInput } from '#middleware/account_access_middleware'
import { passwordProofValidator, socialUnlinkValidator } from '#validators/social'

function identityId(value: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new InvalidInputError('Invalid identity ID')
  return id
}

export default class SocialIdentitiesController {
  async provePassword(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    const { password, purpose } = await ctx.request.validateUsing(passwordProofValidator)
    const proof = await accountKit.socialAuthentication.provePassword({
      current: accountInput(ctx),
      password,
      purpose,
    })
    return ctx.response.ok({ proof })
  }

  async unlink(ctx: HttpContext) {
    const { proof } = await ctx.request.validateUsing(socialUnlinkValidator)
    await accountKit.socialAuthentication.unlink({
      current: accountInput(ctx),
      identityId: identityId(ctx.params.id),
      proof,
    })
    return ctx.response.noContent()
  }
}
