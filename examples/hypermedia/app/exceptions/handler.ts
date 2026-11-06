import { safeOldInput } from '#services/safe_old_input'
import app from '@adonisjs/core/services/app'
import { type HttpContext, ExceptionHandler } from '@adonisjs/core/http'
import type { StatusPageRange, StatusPageRenderer } from '@adonisjs/core/types/http'
import { errors as shieldErrors } from '@adonisjs/shield'
import { errors as limiterErrors } from '@adonisjs/limiter'
import { errors as accountErrors } from '@kevinjohn/adonisjs-account-kit'
import { proofRequest, proofRecovery } from '#services/token_page_headers'

export default class HttpExceptionHandler extends ExceptionHandler {
  /**
   * In debug mode, the exception handler will display verbose errors
   * with pretty printed stack traces.
   */
  protected debug = !app.inProduction

  /**
   * Status pages are used to display custom HTML pages for certain error
   * codes. You might want to enable them in production only, but feel
   * free to enable them in development as well.
   */
  protected renderStatusPages = app.inProduction

  /**
   * Status pages are a collection of error code ranges and callbacks
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
    // Shield's own handler re-flashes every field except snake_case password names, which would
    // store this app's camelCase password fields in the session.
    if (error instanceof shieldErrors.E_BAD_CSRF_TOKEN && ctx.session) {
      const message = error.getResponseMessage(error, ctx)
      if (proofRequest(ctx.request)) {
        ctx.session.flash('error', message)
        ctx.session.flashErrors({ [error.code]: message })
        return ctx.response.redirect((await proofRecovery(ctx.request))!, false)
      }
      ctx.session.flash('input', safeOldInput(ctx.request.all()))
      ctx.session.flash('error', message)
      ctx.session.flashErrors({ [error.code]: message })
      return ctx.response.redirect().back()
    }
    // Account Kit and limiter errors render JSON on their own; this app answers with a page.
    const throttled =
      error instanceof accountErrors.ThrottledError ||
      error instanceof limiterErrors.E_TOO_MANY_REQUESTS
    if ((throttled || error instanceof accountErrors.EmailAlreadyRegisteredError) && ctx.session) {
      ctx.session.flash(
        'error',
        throttled
          ? 'Too many attempts. Wait a few minutes and try again.'
          : 'That email address is already in use.'
      )
      const destination = await proofRecovery(ctx.request)
      if (destination) return ctx.response.redirect(destination, false)
      ctx.session.flash('input', safeOldInput(ctx.request.all()))
      return ctx.response.redirect().back()
    }
    return super.handle(error, ctx)
  }

  async renderValidationErrorAsHTML(
    error: Parameters<ExceptionHandler['renderValidationErrorAsHTML']>[0],
    ctx: HttpContext
  ) {
    if (!ctx.session) return super.renderValidationErrorAsHTML(error, ctx)

    ctx.session.flashValidationErrors(error, false)
    const destination = await proofRecovery(ctx.request)
    if (destination) {
      if (destination === proofRequest(ctx.request)?.fallback)
        ctx.session.flash('error', 'This link is invalid or has expired.')
      return ctx.response.redirect(destination, false)
    }
    ctx.session.flash('input', safeOldInput(ctx.request.all()))
    ctx.response.redirect('back', true)
  }

  /**
   * The method is used to report error to the logging service or
   * a third-party error monitoring service.
   *
   * @note You should not attempt to send a response from this method.
   */
  async report(error: unknown, ctx: HttpContext) {
    return super.report(error, ctx)
  }
}
