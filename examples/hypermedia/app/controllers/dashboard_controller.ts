import type { HttpContext } from '@adonisjs/core/http'

export default class DashboardController {
  async show({ auth, view }: HttpContext) {
    const user = auth.getUserOrFail()
    return view.render('pages/dashboard', {
      user,
      // Account Kit's rule: active once the pending address is not the account's own address.
      verified: user.unverifiedEmail !== user.email,
    })
  }

  async protected({ view }: HttpContext) {
    return view.render('pages/account')
  }
}
