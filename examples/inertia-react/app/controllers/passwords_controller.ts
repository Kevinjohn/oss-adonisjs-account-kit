import kit from '@kevinjohn/adonisjs-account-kit/services/main'
import { errors, passwordChangeRevision } from '@kevinjohn/adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { changePasswordValidator } from '#validators/account'

export default class PasswordsController {
  async edit({ inertia }: HttpContext) {
    return inertia.render('settings/password', {})
  }

  /**
   * Changing the password ends every session. Storing the revision it returns keeps this one;
   * regenerating gives it a new id, so a copied cookie for the old id does not survive.
   */
  async update(ctx: HttpContext) {
    const { currentPassword, password } = await ctx.request.validateUsing(changePasswordValidator)
    const user = ctx.auth.getUserOrFail()
    let revision: string | null
    let followUp = ''
    try {
      ;({ revision } = await kit.emailPasswordManagement.changePassword({
        actorId: user.id,
        currentPassword,
        newPassword: password,
      }))
    } catch (error) {
      // A follow-up failed after commit: the change stands, so keep this session on its revision.
      const committed = passwordChangeRevision(error)
      if (committed === undefined) throw error
      revision = committed
      ctx.logger.error(
        { event: 'password_change_follow_up_failed' },
        'Password changed but a follow-up failed'
      )
      followUp =
        error instanceof errors.DeliveryError
          ? ' The notification email could not be sent.'
          : ' A follow-up step failed.'
    }
    ctx.session.regenerate()
    ctx.session.put('accountKitRevision', revision ?? '')
    ctx.session.flash('success', `Password changed. Other devices have been signed out.${followUp}`)
    return ctx.response.redirect().withQs(false).toPath('/settings/password')
  }
}
