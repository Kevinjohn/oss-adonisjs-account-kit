import app from '@adonisjs/core/services/app'
import { type HttpContext, ExceptionHandler } from '@adonisjs/core/http'
import type { StatusPageRange, StatusPageRenderer } from '@adonisjs/core/types/http'

const SAFE_OLD_INPUT_FIELDS = ['fullName', 'email'] as const

export function safeOldInput(request: HttpContext['request']) {
  const body = request.all()
  const oldInput: Record<string, string> = {}

  for (const field of SAFE_OLD_INPUT_FIELDS) {
    const value = body[field]
    if (typeof value === 'string' && value.length <= 320) oldInput[field] = value
  }

  return oldInput
}

export default class HttpExceptionHandler extends ExceptionHandler {
  /**
   * In debug mode, the exception handler will display verbose errors
   * with pretty printed stack traces.
   */
  protected debug = !app.inProduction

  /**
   * Status pages are used to display a custom HTML pages for certain error
   * codes. You might want to enable them in production only, but feel
   * free to enable them in development as well.
   */
  protected renderStatusPages = app.inProduction

  /**
   * Status pages is a collection of error code range and a callback
   * to return the HTML contents to send as a response.
   */
  protected statusPages: Record<StatusPageRange, StatusPageRenderer> = {
    '404': (error, { view }) => {
      return view.render('pages/errors/not_found', { error })
    },
    '500..599': (error, { view }) => {
      return view.render('pages/errors/server_error', { error })
    },
  }

  /**
   * The method is used for handling errors and returning
   * response to the client
   */
  async handle(error: unknown, ctx: HttpContext) {
    return super.handle(error, ctx)
  }

  async renderValidationErrorAsHTML(
    error: Parameters<ExceptionHandler['renderValidationErrorAsHTML']>[0],
    ctx: HttpContext
  ) {
    if (!ctx.session) return super.renderValidationErrorAsHTML(error, ctx)

    ctx.session.flashValidationErrors(error, false)
    ctx.session.flash('input', safeOldInput(ctx.request))
    ctx.response.redirect('back', true)
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
