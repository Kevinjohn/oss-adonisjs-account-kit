import { defineConfig, services } from '@adonisjs/ally'
import type { InferSocialProviders } from '@adonisjs/ally/types'
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import type { SocialProviderName } from 'adonisjs-account-kit'

const base = env.get('APP_URL').replace(/\/$/, '')
const tokenClientCallback = env.get('SOCIAL_CLIENT_CALLBACK_URL')
if (!app.inTest) {
  for (const key of [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
  ] as const) {
    if (!env.get(key)) throw new Error(`${key} is required for social authentication`)
  }
  if (env.get('ACCOUNT_KIT_AUTH_STRATEGY') !== 'session' && !tokenClientCallback) {
    throw new Error('SOCIAL_CLIENT_CALLBACK_URL is required for token-client social authentication')
  }
}
if (app.inProduction) {
  if (new URL(base).protocol !== 'https:')
    throw new Error('APP_URL must use HTTPS for social authentication')
  if (tokenClientCallback && new URL(tokenClientCallback).protocol !== 'https:') {
    throw new Error('SOCIAL_CLIENT_CALLBACK_URL must use HTTPS in production')
  }
}
const callback = (provider: SocialProviderName) =>
  env.get('ACCOUNT_KIT_AUTH_STRATEGY') === 'session'
    ? `${base}/api/v1/auth/oauth/${provider}/callback`
    : (tokenClientCallback ?? `${base}/api/v1/auth/oauth/${provider}/callback`)

const allyConfig = defineConfig({
  google: services.google({
    clientId: env.get('GOOGLE_CLIENT_ID') ?? '',
    clientSecret: env.get('GOOGLE_CLIENT_SECRET') ?? '',
    callbackUrl: callback('google'),
  }),
  github: services.github({
    clientId: env.get('GITHUB_CLIENT_ID') ?? '',
    clientSecret: env.get('GITHUB_CLIENT_SECRET') ?? '',
    callbackUrl: callback('github'),
    scopes: ['user:email'],
  }),
})

export default allyConfig

declare module '@adonisjs/ally/types' {
  interface SocialProviders extends InferSocialProviders<typeof allyConfig> {}
}
