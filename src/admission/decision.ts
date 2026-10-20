// Evaluates the enabled admission requirements for one user and their admission row.
import type { AccountUser } from '../types.js'
import { domainAllowed, domainOf } from './domain.js'
import type { AdmissionRow } from './rows.js'
import type { AdmissionDecision, ResolvedAdmissionConfig } from './types.js'

/** The account's address is confirmed: verified, and not only waiting for confirmation. */
function hasConfirmedAddress(user: AccountUser): boolean {
  return user.emailVerifiedAt !== null && user.unverifiedEmail !== user.email
}

/** Every enabled requirement against the stored state. Nothing is cached. */
export function evaluateAdmission(
  config: ResolvedAdmissionConfig,
  user: AccountUser,
  row: AdmissionRow | null
): AdmissionDecision {
  const requirements: AdmissionDecision['requirements'] = {}
  if (config.domain) {
    if (!hasConfirmedAddress(user)) requirements.domain = { met: false, reason: 'unverified' }
    else {
      const domain = domainOf(user.email)
      requirements.domain =
        domain !== null && domainAllowed(domain, config.domain)
          ? { met: true }
          : { met: false, reason: 'not_allowed' }
    }
  }
  if (config.invitation)
    requirements.invitation = { met: Boolean(row && row.invitation_recorded_at !== null) }
  if (config.approval) {
    const status = row?.approval_status ?? 'pending'
    requirements.approval = {
      met: status === 'approved',
      status,
      requested: Boolean(row && row.requested_at !== null),
    }
  }
  return {
    admitted: Object.values(requirements).every((requirement) => requirement.met),
    requirements,
  }
}
