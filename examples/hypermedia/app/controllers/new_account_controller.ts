import kit from 'adonisjs-account-kit/services/main'
import { errors } from 'adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { signupValidator } from '#validators/user'
import { accountKitSessionGuard } from '#services/session_guard'
import { isDeliveryFailure } from '#services/delivery_failure'

export default class NewAccountController {
  async create({ view }: HttpContext) {
    return view.render('pages/auth/signup')
  }

  async store(ctx: HttpContext) {
    const { fullName, email, password } = await ctx.request.validateUsing(signupValidator)
    let followUpFailed = false
    try {
      await kit.registration.register({ email, password, registrationData: { fullName } })
    } catch (error) {
      if (error instanceof errors.RegistrationEmailAlreadyRegisteredError) {
        ctx.session.flash(
          'error',
          'We could not create an account with those details. Sign in or try another address.'
        )
        ctx.session.flashOnly(['fullName', 'email'])
        return ctx.response.redirect().back()
      }
      if (!isDeliveryFailure(error)) throw error
      followUpFailed = true
      ctx.logger.error(
        { event: 'signup_follow_up_failed' },
        'Account created but a follow-up did not finish'
      )
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
        'Your account was created. Sign in to request a verification link.'
      )
      return ctx.response.redirect().toRoute('session.create')
    }

    ctx.session.flash(
      'success',
      followUpFailed
        ? 'Your account was created, but we could not confirm the verification email was sent. Wait a minute, then request a fresh link from your dashboard.'
        : 'Account created. Check the development server output for your verification link.'
    )
    return ctx.response.redirect().toRoute('dashboard')
  }
}
