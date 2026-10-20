// Refuses admission operations whose requirement is not configured.
import { CapabilityDisabledError } from '../errors.js'
import type { ResolvedAdmissionConfig } from './types.js'

/** The approval settings, or `CapabilityDisabledError` when approval is not configured. */
export function requireApproval(
  config: ResolvedAdmissionConfig
): NonNullable<ResolvedAdmissionConfig['approval']> {
  if (!config.approval) throw new CapabilityDisabledError('admission approval is disabled')
  return config.approval
}

/** `CapabilityDisabledError` when the invitation requirement is not configured. */
export function requireInvitationRequirement(config: ResolvedAdmissionConfig): void {
  if (!config.invitation) throw new CapabilityDisabledError('admission invitation is disabled')
}
