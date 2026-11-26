import { E_ACCOUNT_KIT_CAPABILITY_DISABLED } from './errors.ts'
import type { ResolvedAuthenticationConfig, ResolvedConfig } from './types.ts'

/** The authentication settings, or `E_ACCOUNT_KIT_CAPABILITY_DISABLED` when authentication is off. */
export function requireAuthentication(config: ResolvedConfig): ResolvedAuthenticationConfig {
  if (!config.authentication)
    throw new E_ACCOUNT_KIT_CAPABILITY_DISABLED('Authentication is disabled')
  return config.authentication
}
