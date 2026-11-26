import type { HttpContext } from '@adonisjs/core/http'
import { E_ACCOUNT_KIT_INVALID_INPUT } from '@kevinjohn/adonisjs-account-kit'
import accountKit from '@kevinjohn/adonisjs-account-kit/services/main'
import { accountInput } from '#middleware/account_access_middleware'
import { passwordProofValidator, socialUnlinkValidator } from '#validators/social'

function identityId(value: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid identity ID')
  return id
}

export default class SocialIdentitiesController {
  async provePassword({ response, request, auth, session }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    const { password, purpose } = await request.validateUsing(passwordProofValidator)
    const proof = await accountKit.socialAuthentication.provePassword({
      current: accountInput({ auth, session }),
      password,
      purpose,
    })
    return response.ok({ proof })
  }

  async unlink({ request, auth, session, params, response }: HttpContext) {
    const { proof } = await request.validateUsing(socialUnlinkValidator)
    await accountKit.socialAuthentication.unlink({
      current: accountInput({ auth, session }),
      identityId: identityId(params.id),
      proof,
    })
    return response.noContent()
  }
}
