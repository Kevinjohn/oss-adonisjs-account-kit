import type { HttpContext } from '@adonisjs/core/http'
import {
  createAllySocialProvider,
  type SocialProvider,
  type SocialProviderName,
} from 'adonisjs-account-kit'

export class SocialProviderExchangeError extends Error {
  constructor(readonly category: 'denied' | 'missing_code' | 'unavailable' | 'provider_mismatch') {
    super('Social provider exchange failed')
  }
}

function requestContext(value: unknown): HttpContext {
  if (!value || typeof value !== 'object' || !('ally' in value)) {
    throw new Error('A request-scoped Ally context is required')
  }
  return value as HttpContext
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
      if (ctx.request.input('error')) throw new SocialProviderExchangeError('denied')
      if (!ctx.request.input('code')) throw new SocialProviderExchangeError('missing_code')
      try {
        return await ctx.ally.use(name).stateless().user()
      } catch {
        throw new SocialProviderExchangeError('unavailable')
      }
    },
  })
}
