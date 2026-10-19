import { randomUUID } from 'node:crypto'
import app from '@adonisjs/core/services/app'
import { type HttpContext, ExceptionHandler } from '@adonisjs/core/http'
import { accountErrorResponse, errors } from 'adonisjs-account-kit'
import { errors as shieldErrors } from '@adonisjs/shield'
import { accountError } from '#services/http_responses'
import { SocialProviderExchangeError } from '#services/social_provider'
import { isSocialPath } from '#services/social_path'

function providerFailure(error: unknown) {
  if (error instanceof SocialProviderExchangeError) return error
  if (
    error instanceof errors.AccountKitError &&
    error.cause instanceof SocialProviderExchangeError
  ) {
    return error.cause
  }
  return undefined
}

function logSocialFailure(
  ctx: HttpContext,
  provider: SocialProviderExchangeError | undefined,
  unexpected: boolean
) {
  const correlationId = randomUUID()
  ctx.response.header('X-Correlation-ID', correlationId)
  const category = provider
    ? `provider_${provider.category}`
    : unexpected
      ? 'unexpected_social_failure'
      : 'service_failure'
  ctx.logger.warn({ correlationId, category }, 'Social account operation failed')
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
    const social = isSocialPath(ctx.request.url())
    const provider = social ? providerFailure(error) : undefined
    const status =
      error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
        ? error.status
        : undefined
    const unexpected =
      social && !provider && !(error instanceof errors.AccountKitError) && !(status && status < 500)
    if (provider || (social && status && status >= 500) || unexpected) {
      logSocialFailure(ctx, provider, unexpected)
    }
    if (error instanceof shieldErrors.E_BAD_CSRF_TOKEN) {
      return accountError(ctx, 403, 'E_BAD_CSRF_TOKEN', error.message)
    }
    const mapped = accountErrorResponse(error)
    if (mapped) {
      for (const [name, value] of Object.entries(mapped.headers)) ctx.response.header(name, value)
      return accountError(
        ctx,
        error instanceof errors.InvalidCredentialsError ? 401 : mapped.status,
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
    if (isSocialPath(ctx.request.url())) return
    return super.report(error, ctx)
  }
}
