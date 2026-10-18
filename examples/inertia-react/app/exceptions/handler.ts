import app from '@adonisjs/core/services/app'
import { type HttpContext, ExceptionHandler } from '@adonisjs/core/http'
import type { StatusPageRange, StatusPageRenderer } from '@adonisjs/core/types/http'
import {
  AccountKitError,
  DeliveryError,
  IdentityNotConfirmedError,
  InvalidCredentialsError,
  InvalidSessionError,
  InvalidTokenError,
  PostCommitError,
  ThrottledError,
} from 'adonisjs-account-kit'

/**
 * Messages for Account Kit errors shown as a flash toast. Anything else gets a generic message,
 * so internal causes never reach the page.
 */
function accountMessage(error: AccountKitError) {
  if (error instanceof InvalidCredentialsError) return 'Invalid email or password.'
  if (error instanceof ThrottledError)
    return `Too many attempts. Try again in ${error.retryAfterSeconds} seconds.`
  if (error instanceof InvalidTokenError) return 'This link is invalid or has expired.'
  if (error instanceof IdentityNotConfirmedError) return 'The password is incorrect.'
  if (error instanceof DeliveryError || error instanceof PostCommitError)
    return 'Your change was saved, but we could not send the email. Try again later.'
  return 'Something went wrong. Please try again.'
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
    '404': (_, { inertia }) => inertia.render('errors/not_found', {}),
    '500..599': (_, { inertia }) => inertia.render('errors/server_error', {}),
  }

  /**
   * The method is used for handling errors and returning
   * response to the client
   */
  async handle(error: unknown, ctx: HttpContext) {
    if (error instanceof InvalidSessionError) {
      await ctx.auth.use('web').logout()
      ctx.session.clear()
      ctx.session.flash('error', 'Your session has ended. Please sign in again.')
      return ctx.response.redirect().toRoute('session.create')
    }
    if (error instanceof AccountKitError) {
      ctx.session.flash('error', accountMessage(error))
      return ctx.response.redirect().back()
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
