import kit from '@kevinjohn/adonisjs-account-kit/services/main'
import { errors } from '@kevinjohn/adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { isDeliveryFailure } from '#services/delivery_failure'
import { sendTokenPageHeaders } from '#services/token_page_headers'
import { verifyEmailValidator } from '#validators/account'

export default class EmailVerificationsController {
  async store({ auth, session, logger, response }: HttpContext) {
    try {
      const outcome = await kit.emailVerification.send({ userId: auth.getUserOrFail().id })
      // A link sent in the last minute is not sent again, so say a link is on its way.
      session.flash(
        'success',
        outcome === 'already_verified'
          ? 'Your email address is already confirmed.'
          : 'A verification link is on its way. Check the development server output.'
      )
    } catch (error) {
      if (!isDeliveryFailure(error)) throw error
      logger.error(
        { event: 'verification_delivery_failed' },
        'Verification email could not be sent'
      )
      session.flash('error', 'We could not send a verification link. Try again in a moment.')
    }
    return response.redirect().back()
  }

  async edit({ response, params, view }: HttpContext) {
    sendTokenPageHeaders(response)
    const valid = await kit.emailVerification.inspect({ token: params.token })
    return view.render('pages/auth/verify_email', { token: params.token, valid })
  }

  async update({ request, params, session, response, logger }: HttpContext) {
    const { password } = await request.validateUsing(verifyEmailValidator)
    try {
      await kit.emailVerification.complete({ token: params.token, password })
    } catch (error) {
      if (error instanceof errors.E_ACCOUNT_KIT_INVALID_TOKEN) {
        session.flash(
          'error',
          'This verification link is invalid, already used, or expired. Sign in to request a fresh one.'
        )
        return response.redirect().withQs(false).toRoute('session.create')
      }
      if (!isDeliveryFailure(error)) throw error
      logger.error(
        { event: 'verification_follow_up_failed' },
        'Verification committed but a follow-up failed'
      )
    }
    session.flash('success', 'Email confirmed. Sign in with the password you chose here.')
    return response.redirect().withQs(false).toRoute('session.create')
  }
}
