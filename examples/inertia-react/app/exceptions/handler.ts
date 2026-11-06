import app from '@adonisjs/core/services/app'
import { type HttpContext, ExceptionHandler } from '@adonisjs/core/http'
import type { StatusPageRange, StatusPageRenderer } from '@adonisjs/core/types/http'
import { errors as shieldErrors } from '@adonisjs/shield'
import { proofRequest, proofRecovery } from '#services/token_page_headers'
import { errors } from '@kevinjohn/adonisjs-account-kit'

/** Maps Account Kit errors to safe flash messages without exposing private causes. */
function accountMessage(error: errors.AccountKitError) {
  if (error instanceof errors.InvalidCredentialsError) return 'Invalid email or password.'
  if (error instanceof errors.ThrottledError)
    return `Too many attempts. Try again in ${error.retryAfterSeconds} seconds.`
  if (error instanceof errors.InvalidTokenError) return 'This link is invalid or has expired.'
  if (error instanceof errors.IdentityNotConfirmedError) return 'The password is incorrect.'
  if (error instanceof errors.DeliveryError)
    return 'Your change was saved, but the email could not be sent. If you need a verification link, wait one minute before requesting another.'
  if (error instanceof errors.PostCommitError)
    return 'Your change was saved, but a follow-up step failed. Check your email if you were expecting a link. If you need a new verification link, wait one minute before requesting another.'
  return 'Something went wrong. Please try again.'
}

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
    '404': (_, { inertia }) => inertia.render('errors/not_found', {}),
    '500..599': (_, { inertia }) => inertia.render('errors/server_error', {}),
  }

  /**
   * Keep validation errors available to Inertia without storing submitted credentials. For plain
   * HTML form submissions, retain only the non-secret fields useful for correcting the form.
   */
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
    if (!ctx.request.header('X-Inertia')) ctx.session.flashOnly(['fullName', 'email'])
    ctx.response.redirect('back', true)
  }

  /**
   * The method is used for handling errors and returning
   * response to the client
   */
  async handle(error: unknown, ctx: HttpContext) {
    if (error instanceof shieldErrors.E_BAD_CSRF_TOKEN && proofRequest(ctx.request)) {
      ctx.session.flash('error', 'The form expired. Please try again.')
      return ctx.response.redirect((await proofRecovery(ctx.request))!, false)
    }
    // Shield re-flashes every field except snake_case password names, which would store this
    // app's camelCase password fields in the session.
    if (error instanceof shieldErrors.E_BAD_CSRF_TOKEN) {
      ctx.session.flashOnly(['fullName', 'email'])
      ctx.session.flash('error', 'The form expired. Please try again.')
      return ctx.response.redirect().back()
    }
    if (error instanceof errors.InvalidSessionError) {
      await ctx.auth.use('web').logout()
      ctx.session.clear()
      ctx.session.flash('error', 'Your session has ended. Please sign in again.')
      return ctx.response.redirect().toRoute('session.create')
    }
    if (error instanceof errors.AccountKitError) {
      ctx.session.flash('error', accountMessage(error))
      const proof = proofRequest(ctx.request)
      if (proof) return ctx.response.redirect(proof.fallback, false)
      return ctx.response.redirect().back()
    }
    return super.handle(error, ctx)
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
