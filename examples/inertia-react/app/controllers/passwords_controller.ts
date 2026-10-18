import app from '@adonisjs/core/services/app'
import { AccountKit } from 'adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { sessionGuard } from '#services/session_guard'
import { changePasswordValidator } from '#validators/account'

export default class PasswordsController {
  async edit({ inertia }: HttpContext) {
    return inertia.render('settings/password', {})
  }

  /**
   * Changing the password ends every session, this one included. Signing in again with the new
   * password keeps the user here while other devices are signed out.
   */
  async update(ctx: HttpContext) {
    const { currentPassword, password } = await ctx.request.validateUsing(changePasswordValidator)
    const user = ctx.auth.getUserOrFail()
    const kit = await app.container.make(AccountKit)
    await kit.emailPasswordManagement.changePassword({
      actorId: user.id,
      currentPassword,
      newPassword: password,
    })
    await kit.authentication.login(
      { email: user.email, password, clientKey: ctx.request.ip() },
      sessionGuard(ctx)
    )
    ctx.session.flash('success', 'Password changed. Other devices have been signed out.')
    ctx.response.redirect().back()
  }
}
