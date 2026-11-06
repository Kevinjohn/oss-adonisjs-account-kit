import { DeliveryError, errors } from '@kevinjohn/adonisjs-account-kit'
import { errors as vineErrors } from '@vinejs/vine'
import kit from '@kevinjohn/adonisjs-account-kit/services/main'
import { signupValidator } from '#validators/user'
import type { HttpContext } from '@adonisjs/core/http'
import { accountKitSessionGuard } from '#services/session_guard'
import { isDeliveryFailure } from '#services/delivery_failure'

export default class NewAccountController {
  async create({ inertia }: HttpContext) {
    return inertia.render('auth/signup', {})
  }

  /**
   * Creates the account and attempts to send a verification link, then signs the new user in. The
   * account stays limited until the link is used.
   */
  async store(ctx: HttpContext) {
    const { fullName, email, password } = await ctx.request.validateUsing(signupValidator)
    let followUp: 'delivery' | 'observer' | undefined
    try {
      await kit.registration.register({ email, password, registrationData: { fullName } })
    } catch (error) {
      // A signup for the same address committed after this one passed the unique rule.
      if (error instanceof errors.RegistrationEmailAlreadyRegisteredError)
        throw new vineErrors.E_VALIDATION_ERROR([
          { field: 'email', rule: 'unique', message: 'This email address is already in use.' },
        ])
      if (!isDeliveryFailure(error)) throw error
      followUp = error instanceof DeliveryError ? 'delivery' : 'observer'
      // Log the event, not the error: its cause can carry the transport's message and proof URL.
      ctx.logger.error(
        { event: 'signup_follow_up_failed' },
        'Account creation committed but a follow-up failed'
      )
    }

    const committedMessage =
      followUp === 'delivery'
        ? 'Your account was created, but the verification email could not be sent.'
        : 'Your account was created, but a follow-up step failed. A verification email may not have been sent.'

    try {
      await kit.authentication.login(
        { email, password, clientKey: ctx.request.ip() },
        accountKitSessionGuard(ctx)
      )
    } catch (error) {
      ctx.logger.error(
        { event: 'signup_sign_in_failed', code: (error as { code?: unknown }).code },
        'Account created but initial sign in failed'
      )
      ctx.session.flash(
        'success',
        followUp
          ? `${committedMessage} We could not sign you in. Please sign in and use the dashboard resend action after one minute if you need a new link.`
          : 'Your account was created, but we could not sign you in. Please sign in to continue.'
      )
      return ctx.response.redirect().toRoute('session.create')
    }

    ctx.session.flash(
      'success',
      followUp
        ? `${committedMessage} Use the dashboard resend action after one minute if you need a new link.`
        : 'Account created. Check your email for a verification link.'
    )
    return ctx.response.redirect().toRoute('dashboard')
  }
}
