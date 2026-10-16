import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { proofHeaders } from '#services/http_responses'

const proofPath =
  /^\/api\/v1\/auth\/(?:password-reset|email-verification|email-change|invitations)\/[^/]+\/?$/

/** Set privacy headers before body parsing or CSRF checks can reject a proof request. */
export default class ProofResponseHeadersMiddleware {
  handle(ctx: HttpContext, next: NextFn) {
    if (proofPath.test(ctx.request.url().split('?')[0])) proofHeaders(ctx)
    return next()
  }
}
