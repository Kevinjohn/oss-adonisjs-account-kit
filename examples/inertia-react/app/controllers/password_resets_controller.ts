import kit from 'adonisjs-account-kit/services/main'
import type { HttpContext } from '@adonisjs/core/http'
import { isDeliveryFailure } from '#services/delivery_failure'
import { accountKitSessionGuard } from '#services/session_guard'
import { sendTokenPageHeaders } from '#services/token_page_headers'
import { forgotPasswordValidator, resetPasswordValidator } from '#validators/account'

export default class PasswordResetsController {
  async create({ inertia }: HttpContext) {
    return inertia.render('auth/forgot_password', {})
  }

  async store({ request, response, session, logger }: HttpContext) {
    const { email } = await request.validateUsing(forgotPasswordValidator)
    try {
      await kit.passwordReset.request({ email, clientKey: request.ip() })
    } catch (error) {
      // Only known addresses get an email, so a delivery failure must not change the response.
      if (!isDeliveryFailure(error)) throw error
      logger.error({ err: error }, 'password reset email failed')
    }
    // The same message for known and unknown addresses.
    session.flash('success', 'If an account exists for that address, we have sent a reset link.')
    return response.redirect().back()
  }

  /**
   * Checks the link without consuming it or changing the current browser session.
   */
  async edit({ inertia, params, response }: HttpContext) {
    sendTokenPageHeaders(response)
    const valid = await kit.passwordReset.inspect({ token: params.token })
    return inertia.render('auth/reset_password', { token: params.token, valid })
  }

  async update(ctx: HttpContext) {
    const { request, response, session, params } = ctx
    const { password } = await request.validateUsing(resetPasswordValidator)
    try {
      await kit.passwordReset.reset({ token: params.token, password })
    } catch (error) {
      if (!isDeliveryFailure(error)) throw error
      ctx.logger.error(
        { event: 'password_reset_follow_up_failed' },
        'password reset follow-up failed'
      )
    }
    if (await ctx.auth.use('web').check()) await accountKitSessionGuard(ctx).terminate()
    session.flash('success', 'Your password has been reset. Sign in with the new password.')
    return response.redirect().toRoute('session.create')
  }
}
