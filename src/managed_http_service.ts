import { InvalidArgumentsException, RuntimeException } from '@adonisjs/core/exceptions'
// Checks and the shared client budget used by the managed HTTP routes.
import { DateTime } from 'luxon'
import { expiresAt } from './ttl.js'
import { E_ACCOUNT_KIT_AUTHORIZATION } from './errors.js'
import { isPasswordAllowed as matchesPasswordPolicy } from './password.js'
import type { Throttler } from './throttle.js'
import type { ResolvedConfig } from './types.js'

type Dependencies = { config: ResolvedConfig; throttler: Throttler }

export function createManagedHttpService(deps: Dependencies) {
  const computeMagicLinkExpiry = (): number =>
    expiresAt(DateTime.utc(), deps.config.expiresIn.magicLink).toMillis()
  const isPasswordAllowed = (value: unknown): value is string =>
    matchesPasswordPolicy(value, deps.config.passwordPolicy)

  return {
    /** Local retention deadline for acknowledged managed magic-link requests. */
    magicLinkExpiresAt: computeMagicLinkExpiry,
    /** Whether `value` is a string that meets the configured password policy. */
    passwordAllowed: isPasswordAllowed,
    /** Throws `E_ACCOUNT_KIT_AUTHORIZATION` unless registration availability is `open`. */
    assertPublicRegistration: (): void => {
      if (deps.config.registration.availability !== 'open')
        throw new E_ACCOUNT_KIT_AUTHORIZATION('Public registration is unavailable')
    },
    /** Throws unless `guard` has the name and strategy set in the `authentication` config. */
    assertGuard: (guard: { name: string; strategy: 'session' | 'access_tokens' }): void => {
      const selected = deps.config.authentication
      if (!selected || selected.guard !== guard.name || selected.strategy !== guard.strategy)
        throw new RuntimeException(
          'Managed routes must use the configured existing authentication guard'
        )
    },
    /** Spend one request from the per-client budget of a managed endpoint. */
    consume: (input: { endpoint: string; clientKey: string }): Promise<void> => {
      if (!input.clientKey)
        return Promise.reject(
          new InvalidArgumentsException('Managed request client key is required')
        )
      return deps.throttler.consume(
        `managed:${input.endpoint}`,
        input.clientKey,
        deps.config.throttle
      )
    },
  }
}
