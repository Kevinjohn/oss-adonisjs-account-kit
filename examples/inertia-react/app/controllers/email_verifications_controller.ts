import kit from 'adonisjs-account-kit/services/main'
import type { HttpContext } from '@adonisjs/core/http'
import { sendTokenPageHeaders } from '#services/token_page_headers'
import { verifyEmailValidator } from '#validators/account'

export default class EmailVerificationsController {
  async store({ auth, response, session }: HttpContext) {
    await kit.emailVerification.send({ userId: auth.getUserOrFail().id })
    session.flash('success', 'We have sent a new verification link.')
    return response.redirect().back()
  }

  async edit({ inertia, params, response }: HttpContext) {
    sendTokenPageHeaders(response)
    const valid = await kit.emailVerification.inspect({ token: params.token })
    return inertia.render('auth/verify_email', { token: params.token, valid })
  }

  /**
   * The address owner sets the account password here, replacing the one chosen at signup, so
   * whoever registered the address cannot keep access. Every session ends, so sign in again.
   */
  async update({ request, response, session, params }: HttpContext) {
    const { password } = await request.validateUsing(verifyEmailValidator)
    await kit.emailVerification.complete({ token: params.token, password })
    session.flash('success', 'Email confirmed. Sign in with your new password.')
    return response.redirect().toRoute('session.create')
  }
}
