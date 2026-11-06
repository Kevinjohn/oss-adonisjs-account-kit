import kit from '@kevinjohn/adonisjs-account-kit/services/main'
import { errors, passwordChangeRevision } from '@kevinjohn/adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { changePasswordValidator } from '#validators/account'

export default class PasswordsController {
  async edit({ view }: HttpContext) {
    return view.render('pages/settings/password')
  }

  async update(ctx: HttpContext) {
    const { currentPassword, password } = await ctx.request.validateUsing(changePasswordValidator)
    const user = ctx.auth.getUserOrFail()
    let notified = true
    let revision: string | null
    try {
      ;({ revision } = await kit.emailPasswordManagement.changePassword({
        actorId: user.id,
        currentPassword,
        newPassword: password,
      }))
    } catch (error) {
      // The new password is already saved; only the notification or another follow-up failed.
      const committed = passwordChangeRevision(error)
      if (committed !== undefined) {
        notified = false
        revision = committed
      } else if (
        error instanceof errors.InvalidCredentialsError ||
        error instanceof errors.IdentityNotConfirmedError
      ) {
        ctx.session.flash('error', 'Your current password is incorrect. Check it and try again.')
        return ctx.response.redirect().back()
      } else throw error
    }
    const unsent = notified ? '' : ' We could not send the confirmation email.'
    // The change ended every session. Storing its revision keeps this one; regenerating gives it a
    // new id, so a copied cookie for the old id does not survive.
    ctx.session.regenerate()
    ctx.session.put('accountKitRevision', revision ?? '')
    ctx.session.flash('success', `Password changed. Other sessions have been signed out.${unsent}`)
    return ctx.response.redirect().toPath('/settings/password')
  }
}
