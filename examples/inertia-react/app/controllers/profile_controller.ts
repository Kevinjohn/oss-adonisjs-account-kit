import kit from 'adonisjs-account-kit/services/main'
import type { HttpContext } from '@adonisjs/core/http'
import { updateProfileValidator } from '#validators/profile'

export default class ProfileController {
  async edit({ auth, inertia }: HttpContext) {
    const user = auth.getUserOrFail()
    return inertia.render('settings/profile', {
      profile: { fullName: user.fullName, email: user.email },
    })
  }

  async update({ auth, request, response, session }: HttpContext) {
    const { fullName, currentPassword } = await request.validateUsing(updateProfileValidator)
    await kit.emailPasswordManagement.updateProfile({
      actorId: auth.getUserOrFail().id,
      currentPassword,
      registrationData: { fullName },
    })
    session.flash('success', 'Your profile has been updated.')
    return response.redirect().toRoute('profile.edit')
  }
}
