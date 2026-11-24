import type { ServiceDependencies } from '../../src/service_dependencies.js'
import { createThrottler } from '../../src/throttle.js'

/** Service dependencies with the throttler built the way `AccountKit` builds it. */
export function serviceDependencies(
  input: Omit<ServiceDependencies, 'throttler'>
): ServiceDependencies {
  return {
    ...input,
    throttler: createThrottler({
      limiter: input.limiter,
      secret: input.config.limiterSecret,
      namespace: input.config.limiterNamespace,
    }),
  }
}
