import kit from 'adonisjs-account-kit/services/main'
import { errors } from 'adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { accountKitSessionGuard } from '#services/session_guard'
import { isDeliveryFailure } from '#services/delivery_failure'
import { changePasswordValidator } from '#validators/account'

export default class PasswordsController {
  async edit({ view }: HttpContext) {
    return view.render('pages/settings/password')
  }

  async update(ctx: HttpContext) {
    const { currentPassword, password } = await ctx.request.validateUsing(changePasswordValidator)
    const user = ctx.auth.getUserOrFail()
    let notified = true
    try {
      await kit.emailPasswordManagement.changePassword({
        actorId: user.id,
        currentPassword,
        newPassword: password,
      })
    } catch (error) {
      // The new password is already saved; only the notification or another follow-up failed.
      if (isDeliveryFailure(error)) notified = false
      else if (
        error instanceof errors.InvalidCredentialsError ||
        error instanceof errors.IdentityNotConfirmedError
      ) {
        ctx.session.flash('error', 'Your current password is incorrect. Check it and try again.')
        return ctx.response.redirect().back()
      } else throw error
    }
    const unsent = notified ? '' : ' We could not send the confirmation email.'

    try {
      await kit.authentication.login(
        { email: user.email, password, clientKey: ctx.request.ip() },
        accountKitSessionGuard(ctx)
      )
    } catch (error) {
      if (!(error instanceof errors.ThrottledError)) throw error
      await accountKitSessionGuard(ctx).terminate()
      ctx.session.flash(
        'success',
        `Password changed. Sign in again with your new password.${unsent}`
      )
      return ctx.response.redirect().toRoute('session.create')
    }
    ctx.session.flash('success', `Password changed. Other sessions have been signed out.${unsent}`)
    return ctx.response.redirect().toPath('/settings/password')
  }
}
