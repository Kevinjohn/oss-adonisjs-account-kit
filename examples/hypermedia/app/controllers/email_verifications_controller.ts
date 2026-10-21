import kit from 'adonisjs-account-kit/services/main'
import { errors } from 'adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { isDeliveryFailure } from '#services/delivery_failure'
import { sendTokenPageHeaders } from '#services/token_page_headers'
import { verifyEmailValidator } from '#validators/account'

export default class EmailVerificationsController {
  async store(ctx: HttpContext) {
    try {
      await kit.emailVerification.send({ userId: ctx.auth.getUserOrFail().id })
      ctx.session.flash(
        'success',
        'A fresh verification link was sent. Check the development server output.'
      )
    } catch (error) {
      if (!isDeliveryFailure(error)) throw error
      ctx.logger.error(
        { event: 'verification_delivery_failed' },
        'Verification email could not be sent'
      )
      ctx.session.flash('error', 'We could not send a verification link. Try again in a moment.')
    }
    return ctx.response.redirect().back()
  }

  async edit(ctx: HttpContext) {
    sendTokenPageHeaders(ctx.response)
    const valid = await kit.emailVerification.inspect({ token: ctx.params.token })
    return ctx.view.render('pages/auth/verify_email', { token: ctx.params.token, valid })
  }

  async update(ctx: HttpContext) {
    const { password } = await ctx.request.validateUsing(verifyEmailValidator)
    try {
      await kit.emailVerification.complete({ token: ctx.params.token, password })
    } catch (error) {
      if (error instanceof errors.InvalidTokenError) {
        ctx.session.flash(
          'error',
          'This verification link is invalid, already used, or expired. Sign in to request a fresh one.'
        )
        return ctx.response.redirect().toRoute('session.create')
      }
      if (!isDeliveryFailure(error)) throw error
      ctx.logger.error(
        { event: 'verification_follow_up_failed' },
        'Verification committed but a follow-up failed'
      )
    }
    ctx.session.flash('success', 'Email confirmed. Sign in with the password you chose here.')
    return ctx.response.redirect().toRoute('session.create')
  }
}
