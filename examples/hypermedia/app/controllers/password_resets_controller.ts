import kit from '@kevinjohn/adonisjs-account-kit/services/main'
import { errors } from '@kevinjohn/adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { isDeliveryFailure } from '#services/delivery_failure'
import { sendTokenPageHeaders } from '#services/token_page_headers'
import { forgotPasswordValidator, resetPasswordValidator } from '#validators/account'

export default class PasswordResetsController {
  async create({ view }: HttpContext) {
    return view.render('pages/auth/forgot_password')
  }

  async store({ request, logger, session, response }: HttpContext) {
    const { email } = await request.validateUsing(forgotPasswordValidator)
    try {
      await kit.passwordReset.request({ email, clientKey: request.ip() })
    } catch (error) {
      if (!isDeliveryFailure(error)) throw error
      logger.error(
        { event: 'password_reset_delivery_failed' },
        'Password reset email could not be sent'
      )
    }
    session.flash('success', 'If an account exists for that address, we have sent a reset link.')
    return response.redirect().back()
  }

  async edit({ response, params, view }: HttpContext) {
    sendTokenPageHeaders(response)
    const valid = await kit.passwordReset.inspect({ token: params.token })
    return view.render('pages/auth/reset_password', { token: params.token, valid })
  }

  async update({ request, params, session, response, logger }: HttpContext) {
    const { password } = await request.validateUsing(resetPasswordValidator)
    try {
      await kit.passwordReset.reset({ token: params.token, password })
    } catch (error) {
      if (error instanceof errors.E_ACCOUNT_KIT_INVALID_TOKEN) {
        session.flash(
          'error',
          'This reset link is invalid, already used, or expired. Request a fresh link.'
        )
        return response.redirect().withQs(false).toPath('/forgot-password')
      }
      if (!isDeliveryFailure(error)) throw error
      logger.error(
        { event: 'password_reset_follow_up_failed' },
        'Reset committed but a follow-up failed'
      )
    }
    session.flash('success', 'Your password has been reset. Sign in with the new password.')
    return response.redirect().withQs(false).toRoute('session.create')
  }
}
