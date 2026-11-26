import { safeOldInput } from '#services/safe_old_input'
import kit from '@kevinjohn/adonisjs-account-kit/services/main'
import { errors } from '@kevinjohn/adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { updateProfileValidator } from '#validators/profile'

export default class ProfileController {
  async edit({ auth, view }: HttpContext) {
    const user = auth.getUserOrFail()
    return view.render('pages/settings/profile', { fullName: user.fullName, email: user.email })
  }

  async update({ request, auth, session, response }: HttpContext) {
    const { fullName, currentPassword } = await request.validateUsing(updateProfileValidator)
    try {
      await kit.emailPasswordManagement.updateProfile({
        actorId: auth.getUserOrFail().id,
        currentPassword,
        registrationData: { fullName },
      })
    } catch (error) {
      if (
        !(error instanceof errors.E_INVALID_CREDENTIALS) &&
        !(error instanceof errors.E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED)
      )
        throw error
      session.flash('error', 'Your current password is incorrect. Check it and try again.')
      session.flash('input', safeOldInput({ fullName }))
      return response.redirect().back()
    }
    session.flash('success', 'Your profile has been updated.')
    return response.redirect().toPath('/settings/profile')
  }
}
