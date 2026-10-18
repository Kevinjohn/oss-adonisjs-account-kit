import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { forgotPasswordValidator, resetPasswordValidator } from '#validators/account'

export default class PasswordResetsController {
  async create({ inertia }: HttpContext) {
    return inertia.render('auth/forgot_password', {})
  }

  async store({ request, response, session }: HttpContext) {
    const { email } = await request.validateUsing(forgotPasswordValidator)
    const kit = await app.container.make(AccountKit)
    await kit.passwordReset.request({ email, clientKey: request.ip() })
    // The same message for known and unknown addresses.
    session.flash('success', 'If an account exists for that address, we have sent a reset link.')
    response.redirect().back()
  }

  /**
   * Checks the link without using it up, so an expired link is reported before the user types
   * a new password.
   */
  async edit({ inertia, params, response }: HttpContext) {
    response.header('Referrer-Policy', 'no-referrer')
    const kit = await app.container.make(AccountKit)
    const valid = await kit.passwordReset.inspect({ token: params.token })
    return inertia.render('auth/reset_password', { token: params.token, valid })
  }

  async update({ request, response, session, params }: HttpContext) {
    const { password } = await request.validateUsing(resetPasswordValidator)
    const kit = await app.container.make(AccountKit)
    await kit.passwordReset.reset({ token: params.token, password })
    session.flash('success', 'Your password has been reset. Sign in with the new password.')
    response.redirect().toRoute('session.create')
  }
}
