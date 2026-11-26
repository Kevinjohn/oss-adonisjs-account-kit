// Refuses admission operations whose requirement is not configured.
import { E_ACCOUNT_KIT_CAPABILITY_DISABLED } from '../errors.ts'
import type { ResolvedAdmissionConfig } from './types.ts'

/** The approval settings, or `E_ACCOUNT_KIT_CAPABILITY_DISABLED` when approval is not configured. */
export function requireApproval(
  config: ResolvedAdmissionConfig
): NonNullable<ResolvedAdmissionConfig['approval']> {
  if (!config.approval)
    throw new E_ACCOUNT_KIT_CAPABILITY_DISABLED('admission approval is disabled')
  return config.approval
}

/** `E_ACCOUNT_KIT_CAPABILITY_DISABLED` when the invitation requirement is not configured. */
export function requireInvitationRequirement(config: ResolvedAdmissionConfig): void {
  if (!config.invitation)
    throw new E_ACCOUNT_KIT_CAPABILITY_DISABLED('admission invitation is disabled')
}
