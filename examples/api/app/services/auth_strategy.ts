import env from '#start/env'

/** The example's selected auth strategy. Tests switch it; an application keeps one. */
export function authStrategy() {
  return env.get('ACCOUNT_KIT_AUTH_STRATEGY') ?? 'access_tokens'
}

/** The AdonisJS guard for the selected auth strategy. */
export function selectedGuardName() {
  return authStrategy() === 'session' ? 'web' : 'api'
}
