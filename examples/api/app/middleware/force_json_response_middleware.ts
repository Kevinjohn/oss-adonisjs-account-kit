import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

export default class ForceJsonResponseMiddleware {
  handle(ctx: HttpContext, next: NextFn) {
    if (!ctx.request.header('accept')?.includes('application/vnd.api+json')) {
      ctx.request.request.headers.accept = 'application/json'
    }
    return next()
  }
}
