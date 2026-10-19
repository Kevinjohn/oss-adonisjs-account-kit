import { randomUUID } from 'node:crypto'
import app from '@adonisjs/core/services/app'
import { type HttpContext, ExceptionHandler } from '@adonisjs/core/http'
import {
  AccountKitError,
  accountErrorResponse,
  InvalidCredentialsError,
} from 'adonisjs-account-kit'
import { errors as shieldErrors } from '@adonisjs/shield'
import { accountError } from '#services/http_responses'
import { SocialProviderExchangeError } from '#services/social_provider'

function isSocialRequest(ctx: HttpContext) {
  const path = ctx.request.url().split('?', 1)[0]
  return (
    path.startsWith('/api/v1/auth/oauth/') ||
    path.startsWith('/api/v1/account/social/') ||
    path === '/api/v1/account/methods' ||
    path.startsWith('/api/v1/auth/social-verification/')
  )
}

function providerFailure(error: unknown) {
  if (error instanceof SocialProviderExchangeError) return error
  if (error instanceof AccountKitError && error.cause instanceof SocialProviderExchangeError) {
    return error.cause
  }
  return undefined
}

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
    const social = isSocialRequest(ctx)
    const provider = social ? providerFailure(error) : undefined
    const status =
      error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
        ? error.status
        : undefined
    const unexpected =
      social && !provider && !(error instanceof AccountKitError) && !(status && status < 500)
    if (provider || (social && status && status >= 500) || unexpected) {
      const correlationId = randomUUID()
      ctx.response.header('X-Correlation-ID', correlationId)
      const category = provider
        ? `provider_${provider.category}`
        : unexpected
          ? 'unexpected_social_failure'
          : 'service_failure'
      ctx.logger.warn({ correlationId, category }, 'Social account operation failed')
    }
    if (error instanceof shieldErrors.E_BAD_CSRF_TOKEN) {
      return accountError(ctx, 403, 'E_BAD_CSRF_TOKEN', error.message)
    }
    const mapped = accountErrorResponse(error)
    if (mapped) {
      for (const [name, value] of Object.entries(mapped.headers)) ctx.response.header(name, value)
      return accountError(
        ctx,
        error instanceof InvalidCredentialsError ? 401 : mapped.status,
        mapped.body.code,
        mapped.body.message
      )
    }
    if (social && (provider || unexpected)) {
      return accountError(
        ctx,
        provider ? 503 : 500,
        'E_ACCOUNT_KIT_SOCIAL_UNAVAILABLE',
        'Account operation unavailable'
      )
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
    if (isSocialRequest(ctx)) return
    return super.report(error, ctx)
  }
}
