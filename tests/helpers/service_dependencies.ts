import type { ServiceDependencies } from '../../src/service_dependencies.ts'
import { createThrottler } from '../../src/throttle.ts'

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
