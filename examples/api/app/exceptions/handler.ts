import app from '@adonisjs/core/services/app'
import { type HttpContext, ExceptionHandler } from '@adonisjs/core/http'
import { accountErrorResponse } from 'adonisjs-account-kit'
import { errors as shieldErrors } from '@adonisjs/shield'

export default class HttpExceptionHandler extends ExceptionHandler {
  /**
   * In debug mode, the exception handler will display verbose errors
   * with pretty printed stack traces.
   */
  protected debug = !app.inProduction

  /**
   * The method is used for handling errors and returning
   * response to the client
   */
  async handle(error: unknown, ctx: HttpContext) {
    if (error instanceof shieldErrors.E_BAD_CSRF_TOKEN) {
      return ctx.response.status(403).send({ code: 'E_BAD_CSRF_TOKEN', message: error.message })
    }
    const mapped = accountErrorResponse(error)
    if (mapped) {
      for (const [name, value] of Object.entries(mapped.headers)) ctx.response.header(name, value)
      return ctx.response.status(mapped.status).send(mapped.body)
    }
    return super.handle(error, ctx)
  }

  /**
   * The method is used to report error to the logging service or
   * the a third party error monitoring service.
   *
   * @note You should not attempt to send a response from this method.
   */
  async report(error: unknown, ctx: HttpContext) {
    return super.report(error, ctx)
  }
}
