import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { verifyEmailValidator } from '#validators/account'

export default class EmailVerificationsController {
  async store({ auth, response, session }: HttpContext) {
    const kit = await app.container.make(AccountKit)
    await kit.emailVerification.send({ userId: auth.getUserOrFail().id })
    session.flash('success', 'We have sent a new verification link.')
    response.redirect().back()
  }

  async edit({ inertia, params, response }: HttpContext) {
    response.header('Referrer-Policy', 'no-referrer')
    const kit = await app.container.make(AccountKit)
    const valid = await kit.emailVerification.inspect({ token: params.token })
    return inertia.render('auth/verify_email', { token: params.token, valid })
  }

  /**
   * The address owner sets the account password here, replacing the one chosen at signup, so
   * whoever registered the address cannot keep access. Every session ends, so sign in again.
   */
  async update({ request, response, session, params }: HttpContext) {
    const { password } = await request.validateUsing(verifyEmailValidator)
    const kit = await app.container.make(AccountKit)
    await kit.emailVerification.complete({ token: params.token, password })
    session.flash('success', 'Email confirmed. Sign in with your new password.')
    response.redirect().toRoute('session.create')
  }
}
