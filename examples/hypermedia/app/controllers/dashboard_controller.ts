import type { HttpContext } from '@adonisjs/core/http'

export default class DashboardController {
  async show({ auth, view }: HttpContext) {
    const user = auth.getUserOrFail()
    return view.render('pages/dashboard', {
      user,
      verified: !!user.emailVerifiedAt,
    })
  }

  async protected({ view }: HttpContext) {
    return view.render('pages/account')
  }
}
