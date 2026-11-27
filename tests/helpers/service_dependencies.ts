import { ExportFaults } from '../../src/account_export.ts'
import type { ServiceDependencies } from '../../src/service_dependencies.ts'
import { createThrottler } from '../../src/throttle.ts'

/** Service dependencies with the throttler built the way `AccountKit` builds it. */
export function serviceDependencies(
  input: Omit<ServiceDependencies, 'throttler' | 'exportFaults'>
): ServiceDependencies {
  return {
    ...input,
    throttler: createThrottler({
      limiter: input.limiter,
      secret: input.config.limiterSecret,
      namespace: input.config.limiterNamespace,
    }),
    exportFaults: new ExportFaults(),
  }
}
