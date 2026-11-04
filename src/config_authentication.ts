// Validates and defaults the authentication option.
import { DateTime } from 'luxon'
import { budget } from './config_budget.js'
import { assertObject } from './config_assert.js'
import { InvalidConfigurationError } from './errors.js'
import { isSqlIdentifier } from './sql_identifier.js'
import { configuredExpiresAt } from './config_ttl.js'
import type { AccountKitConfig, ResolvedAuthenticationConfig } from './types.js'
import { freezeResolved } from './config_freeze.js'

export function resolveAuthentication(
  config: Pick<AccountKitConfig, 'authentication'>
): ResolvedAuthenticationConfig | undefined {
  let authentication: ResolvedAuthenticationConfig | undefined
  if (config.authentication !== undefined) {
    const auth = config.authentication
    assertObject(auth, 'authentication')
    if (auth.strategy !== 'session' && auth.strategy !== 'access_tokens')
      throw new InvalidConfigurationError(
        'authentication.strategy',
        'account_kit: authentication.strategy must be session or access_tokens'
      )
    if (typeof auth.guard !== 'string' || auth.guard.trim() === '')
      throw new InvalidConfigurationError(
        'authentication.guard',
        'account_kit: authentication.guard must name an existing guard'
      )
    if (auth.canAccess !== undefined && typeof auth.canAccess !== 'function')
      throw new InvalidConfigurationError(
        'authentication.canAccess',
        'account_kit: authentication.canAccess must be a function'
      )
    if (
      auth.tokenAbilities !== undefined &&
      (!Array.isArray(auth.tokenAbilities) ||
        auth.tokenAbilities.length === 0 ||
        auth.tokenAbilities.some((ability) => typeof ability !== 'string' || ability.trim() === ''))
    )
      throw new InvalidConfigurationError(
        'authentication.tokenAbilities',
        'account_kit: authentication.tokenAbilities must be non-empty strings'
      )
    if (auth.tokenExpiresIn !== undefined)
      configuredExpiresAt('authentication.tokenExpiresIn', DateTime.utc(), auth.tokenExpiresIn)
    const tokenTable = auth.tokenTable ?? 'auth_access_tokens'
    if (typeof tokenTable !== 'string' || !isSqlIdentifier(tokenTable))
      throw new InvalidConfigurationError(
        'authentication.tokenTable',
        'account_kit: authentication.tokenTable must be a plain SQL identifier'
      )
    const clientLimit = budget(
      auth.clientLimit,
      { requests: 10, duration: '1m' },
      'authentication.clientLimit'
    )
    const identityLimit = budget(
      auth.identityLimit,
      { requests: 5, duration: '1m' },
      'authentication.identityLimit'
    )
    const blockDuration = auth.identityLimit?.blockDuration ?? '20m'
    budget(
      { requests: 1, duration: blockDuration },
      { requests: 1, duration: '20m' },
      'authentication.identityLimit',
      'authentication.identityLimit.blockDuration'
    )
    authentication = {
      strategy: auth.strategy,
      guard: auth.guard,
      canAccess: auth.canAccess ?? (async () => true),
      clientLimit,
      identityLimit: freezeResolved({ ...identityLimit, blockDuration }),
      tokenAbilities: freezeResolved([...(auth.tokenAbilities ?? ['*'])]),
      tokenExpiresIn: auth.tokenExpiresIn ?? null,
      tokenTable,
    }
  }
  return authentication && freezeResolved(authentication)
}
