import { CapabilityDisabledError } from './errors.js'
import type { ResolvedAuthenticationConfig, ResolvedConfig } from './types.js'

/** The authentication settings, or `CapabilityDisabledError` when authentication is off. */
export function requireAuthentication(config: ResolvedConfig): ResolvedAuthenticationConfig {
  if (!config.authentication) throw new CapabilityDisabledError('Authentication is disabled')
  return config.authentication
}
