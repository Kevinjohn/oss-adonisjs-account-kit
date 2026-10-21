import kit from 'adonisjs-account-kit/services/main'
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
    let postCommitFailed = false
    try {
      await kit.registration.register({ email, password, registrationData: { fullName } })
    } catch (error) {
      if (!isDeliveryFailure(error)) throw error
      postCommitFailed = true
      ctx.logger.error({ err: error }, 'Account creation committed but a follow-up failed')
    }

    try {
      await kit.authentication.login(
        { email, password, clientKey: ctx.request.ip() },
        accountKitSessionGuard(ctx)
      )
    } catch (error) {
      ctx.logger.error({ err: error }, 'Account created but initial sign in failed')
      ctx.session.flash(
        'success',
        postCommitFailed
          ? 'Your account was created, but we could not confirm that the verification email was sent or sign you in. Please sign in to request another verification email.'
          : 'Your account was created, but we could not sign you in. Please sign in to continue.'
      )
      return ctx.response.redirect().toRoute('session.create')
    }

    ctx.session.flash(
      'success',
      postCommitFailed
        ? 'Your account was created, but we could not confirm that the verification email was sent. Use the resend link on your dashboard to request another email.'
        : 'Account created. Check your email for a verification link.'
    )
    return ctx.response.redirect().toRoute('dashboard')
  }
}
