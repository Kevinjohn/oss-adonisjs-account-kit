import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/** Runs before body parsing, session, CSRF, and authentication for social HTTP paths. */
export default class SocialResponseHeadersMiddleware {
  handle(ctx: HttpContext, next: NextFn) {
    const path = ctx.request.url().split('?', 1)[0]
    if (
      path.startsWith('/api/v1/auth/oauth/') ||
      path.startsWith('/api/v1/account/social/') ||
      path === '/api/v1/account/methods' ||
      path.startsWith('/api/v1/auth/social-verification/')
    ) {
      ctx.response.header('Cache-Control', 'no-store')
      ctx.response.header('Referrer-Policy', 'no-referrer')
    }
    return next()
  }
}
