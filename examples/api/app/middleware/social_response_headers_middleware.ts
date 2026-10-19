import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { isSocialPath } from '#services/social_path'

/** Runs before body parsing, session, CSRF, and authentication for social HTTP paths. */
export default class SocialResponseHeadersMiddleware {
  handle(ctx: HttpContext, next: NextFn) {
    if (isSocialPath(ctx.request.url())) {
      ctx.response.header('Cache-Control', 'no-store')
      ctx.response.header('Referrer-Policy', 'no-referrer')
    }
    return next()
  }
}
