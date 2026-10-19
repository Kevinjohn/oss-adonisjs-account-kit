import type { HttpContext } from '@adonisjs/core/http'
import { wantsJsonApi } from '#services/accept_negotiation'

export { wantsJsonApi }

/** Public example responses for proof links and account errors. */
export function accountError(
  ctx: HttpContext,
  status: number,
  code: string,
  message: string,
  field?: string
) {
  const jsonApi = wantsJsonApi(ctx.request.header('accept'))
  if (jsonApi) ctx.response.type('application/vnd.api+json')
  const error = jsonApi ? { code, title: message } : { code, message, ...(field ? { field } : {}) }
  return ctx.response.status(status).send({ errors: [error] })
}

export function proofHeaders(ctx: HttpContext) {
  ctx.response.header('Cache-Control', 'no-store')
  ctx.response.header('Referrer-Policy', 'no-referrer')
}

export function proofFailure(ctx: HttpContext, code: string) {
  return accountError(ctx, 400, code, 'This link is invalid or expired.')
}
