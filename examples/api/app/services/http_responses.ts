import type { HttpContext } from '@adonisjs/core/http'

/** The framework's negotiation, as the package's own errors use it: on a tie, the first listed type wins. */
export function wantsJsonApi(ctx: HttpContext) {
  return (
    ctx.request.accepts(['application/json', 'application/vnd.api+json']) ===
    'application/vnd.api+json'
  )
}

/** Public example responses for proof links and account errors. */
export function accountError(
  ctx: HttpContext,
  status: number,
  code: string,
  message: string,
  field?: string,
  // Extra top-level members; a JSON:API body carries them in `meta`.
  extra?: Record<string, unknown>
) {
  const jsonApi = wantsJsonApi(ctx)
  if (jsonApi) ctx.response.type('application/vnd.api+json')
  const error = jsonApi ? { code, title: message } : { code, message, ...(field ? { field } : {}) }
  const members = extra ? (jsonApi ? { meta: extra } : extra) : {}
  return ctx.response.status(status).send({ errors: [error], ...members })
}

export function proofHeaders(ctx: HttpContext) {
  ctx.response.header('Cache-Control', 'no-store')
  ctx.response.header('Referrer-Policy', 'no-referrer')
}

export function proofFailure(ctx: HttpContext, code: string) {
  return accountError(ctx, 400, code, 'This link is invalid or expired.')
}
