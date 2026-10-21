import type { HttpContext } from '@adonisjs/core/http'

export default class AccountController {
  async show({ inertia }: HttpContext) {
    return inertia.render('account', {})
  }
}
