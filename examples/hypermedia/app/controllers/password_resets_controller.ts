import kit from 'adonisjs-account-kit/services/main'
import { errors } from 'adonisjs-account-kit'
import { errors as vineErrors } from '@vinejs/vine'
import type { HttpContext } from '@adonisjs/core/http'
import { isDeliveryFailure } from '#services/delivery_failure'
import { sendTokenPageHeaders } from '#services/token_page_headers'
import { forgotPasswordValidator, resetPasswordValidator } from '#validators/account'

export default class PasswordResetsController {
  async create({ view }: HttpContext) {
    return view.render('pages/auth/forgot_password')
  }

  async store(ctx: HttpContext) {
    const { email } = await ctx.request.validateUsing(forgotPasswordValidator)
    try {
      await kit.passwordReset.request({ email, clientKey: ctx.request.ip() })
    } catch (error) {
      if (!isDeliveryFailure(error)) throw error
      ctx.logger.error(
        { event: 'password_reset_delivery_failed' },
        'Password reset email could not be sent'
      )
    }
    ctx.session.flash(
      'success',
      'If an account exists for that address, we have sent a reset link.'
    )
    return ctx.response.redirect().back()
  }

  async edit(ctx: HttpContext) {
    sendTokenPageHeaders(ctx.response)
    const valid = await kit.passwordReset.inspect({ token: ctx.params.token })
    return ctx.view.render('pages/auth/reset_password', { token: ctx.params.token, valid })
  }

  async update(ctx: HttpContext) {
    let password: string
    try {
      const validated = await ctx.request.validateUsing(resetPasswordValidator)
      password = validated.password
    } catch (error) {
      if (!(error instanceof vineErrors.E_VALIDATION_ERROR)) throw error
      ctx.session.flashValidationErrors(error, false)
      return ctx.response
        .redirect()
        .toPath(`/reset-password/${encodeURIComponent(ctx.params.token)}`)
    }
    try {
      await kit.passwordReset.reset({ token: ctx.params.token, password })
    } catch (error) {
      if (error instanceof errors.InvalidTokenError) {
        ctx.session.flash(
          'error',
          'This reset link is invalid, already used, or expired. Request a fresh link.'
        )
        return ctx.response.redirect().toPath('/forgot-password')
      }
      if (!isDeliveryFailure(error)) throw error
      ctx.logger.error(
        { event: 'password_reset_follow_up_failed' },
        'Reset committed but a follow-up failed'
      )
    }
    ctx.session.flash('success', 'Your password has been reset. Sign in with the new password.')
    return ctx.response.redirect().toRoute('session.create')
  }
}
