import config from '@adonisjs/core/services/config'

/** The example's selected auth strategy. Tests switch it; an application keeps one. */
export function authStrategy() {
  return config.get<'access_tokens' | 'session'>('reference.authStrategy')
}

/** The AdonisJS guard for the selected auth strategy. */
export function selectedGuardName() {
  return authStrategy() === 'session' ? 'web' : 'api'
}
