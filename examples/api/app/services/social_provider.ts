import type { HttpContext } from '@adonisjs/core/http'
import {
  createAllySocialProvider,
  type SocialProvider,
  type SocialProviderName,
} from '@kevinjohn/adonisjs-account-kit'

import SocialProviderExchangeError from '#exceptions/social_provider_exchange_exception'
import { socialProviderCallbackValidator } from '#validators/social'

export { default as SocialProviderExchangeError } from '#exceptions/social_provider_exchange_exception'

function requestContext(value: unknown): Pick<HttpContext, 'ally' | 'params' | 'request'> {
  if (!value || typeof value !== 'object' || !('ally' in value)) {
    throw new Error('A request-scoped Ally context is required')
  }
  return value as Pick<HttpContext, 'ally' | 'params' | 'request'>
}

export function allySocialProvider(name: SocialProviderName): SocialProvider {
  return createAllySocialProvider({
    async authorizationUrl(state, context) {
      try {
        return await requestContext(context)
          .ally.use(name)
          .stateless()
          .redirectUrl((request) => request.param('state', state))
      } catch {
        throw new SocialProviderExchangeError('unavailable')
      }
    },
    async user(callback) {
      const ctx = requestContext(callback)
      if (ctx.params.provider !== name) throw new SocialProviderExchangeError('provider_mismatch')
      const { error, code } = await ctx.request.validateUsing(socialProviderCallbackValidator)
      if (error) throw new SocialProviderExchangeError('denied')
      if (!code) throw new SocialProviderExchangeError('missing_code')
      try {
        return await ctx.ally.use(name).stateless().user()
      } catch {
        throw new SocialProviderExchangeError('unavailable')
      }
    },
  })
}
