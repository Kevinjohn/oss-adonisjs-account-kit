// Checks and the shared client budget used by the managed HTTP routes.
import { AuthorizationError } from './errors.js'
import { isPasswordAllowed } from './password.js'
import type { Throttler } from './throttle.js'
import type { ResolvedConfig } from './types.js'

type Dependencies = { config: ResolvedConfig; throttler: Throttler }

export function managedHttpService(deps: Dependencies) {
  return {
    /** Whether `value` is a string that meets the configured password policy. */
    passwordAllowed: (value: unknown): value is string =>
      isPasswordAllowed(value, deps.config.passwordPolicy),
    /** Throws `AuthorizationError` unless registration availability is `open`. */
    assertPublicRegistration: (): void => {
      if (deps.config.registration.availability !== 'open')
        throw new AuthorizationError('Public registration is unavailable')
    },
    /** Throws unless `guard` has the name and strategy set in the `authentication` config. */
    assertGuard: (guard: { name: string; strategy: 'session' | 'access_tokens' }): void => {
      const selected = deps.config.authentication
      if (!selected || selected.guard !== guard.name || selected.strategy !== guard.strategy)
        throw new Error('Managed routes must use the configured existing authentication guard')
    },
    /** Spend one request from the per-client budget of a managed endpoint. */
    consume: (input: { endpoint: string; clientKey: string }): Promise<void> => {
      if (!input.clientKey)
        return Promise.reject(new Error('Managed request client key is required'))
      return deps.throttler.consume(
        `managed:${input.endpoint}`,
        input.clientKey,
        deps.config.throttle
      )
    },
  }
}
