import env from '#start/env'

export default {
  authStrategy: env.get('ACCOUNT_KIT_AUTH_STRATEGY') ?? 'access_tokens',
  socialThrottleSecret: env.get('APP_KEY'),
}
