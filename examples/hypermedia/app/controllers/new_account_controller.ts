import kit from '@kevinjohn/adonisjs-account-kit/services/main'
import limiter from '@adonisjs/limiter/services/main'
import { errors } from '@kevinjohn/adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { signupValidator } from '#validators/user'
import { accountKitSessionGuard } from '#services/session_guard'
import { isDeliveryFailure } from '#services/delivery_failure'

export default class NewAccountController {
  async create({ view }: HttpContext) {
    return view.render('pages/auth/signup')
  }

  async store({ request, session, response, logger, auth }: HttpContext) {
    // Registration has no throttle of its own: bound account creation and activation mail per client.
    await limiter
      .use({ requests: 5, duration: '15 minutes' })
      .consume(`account-signup:${request.ip()}`)
    const { fullName, email, password } = await request.validateUsing(signupValidator)
    let followUpFailed = false
    try {
      await kit.registration.register({ email, password, registrationData: { fullName } })
    } catch (error) {
      if (error instanceof errors.E_ACCOUNT_KIT_REGISTRATION_EMAIL_ALREADY_REGISTERED) {
        session.flash(
          'error',
          'We could not create an account with those details. Sign in or try another address.'
        )
        session.flashOnly(['fullName', 'email'])
        return response.redirect().back()
      }
      if (!isDeliveryFailure(error)) throw error
      followUpFailed = true
      logger.error(
        { event: 'signup_follow_up_failed' },
        'Account created but a follow-up did not finish'
      )
    }

    try {
      await kit.authentication.login(
        { email, password, clientKey: request.ip() },
        accountKitSessionGuard({ auth, session })
      )
    } catch (error) {
      logger.error(
        { event: 'signup_sign_in_failed', code: (error as { code?: unknown }).code },
        'Account created but initial sign in failed'
      )
      session.flash('success', 'Your account was created. Sign in to request a verification link.')
      return response.redirect().toRoute('session.create')
    }

    session.flash(
      'success',
      followUpFailed
        ? 'Your account was created, but we could not confirm the verification email was sent. Wait a minute, then request a fresh link from your dashboard.'
        : 'Account created. Check the development server output for your verification link.'
    )
    return response.redirect().toRoute('dashboard')
  }
}
