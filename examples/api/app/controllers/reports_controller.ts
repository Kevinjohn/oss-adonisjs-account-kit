import type { HttpContext } from '@adonisjs/core/http'

/** The protected-data sample: only admitted accounts reach it. */
export default class ReportsController {
  async index(ctx: HttpContext) {
    return ctx.response.ok({ reports: [] })
  }
}
