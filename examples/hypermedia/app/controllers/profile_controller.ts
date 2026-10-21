import kit from 'adonisjs-account-kit/services/main'
import { errors } from 'adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { updateProfileValidator } from '#validators/profile'

export default class ProfileController {
  async edit({ auth, view }: HttpContext) {
    const user = auth.getUserOrFail()
    return view.render('pages/settings/profile', { fullName: user.fullName, email: user.email })
  }

  async update(ctx: HttpContext) {
    const { fullName, currentPassword } = await ctx.request.validateUsing(updateProfileValidator)
    try {
      await kit.emailPasswordManagement.updateProfile({
        actorId: ctx.auth.getUserOrFail().id,
        currentPassword,
        registrationData: { fullName },
      })
    } catch (error) {
      if (
        !(error instanceof errors.InvalidCredentialsError) &&
        !(error instanceof errors.IdentityNotConfirmedError)
      )
        throw error
      ctx.session.flash('error', 'Your current password is incorrect. Check it and try again.')
      ctx.session.flashOnly(['fullName'])
      return ctx.response.redirect().back()
    }
    ctx.session.flash('success', 'Your profile has been updated.')
    return ctx.response.redirect().toPath('/settings/profile')
  }
}
