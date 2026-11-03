// Validates `config/admission.ts` at boot.
import { InvalidConfigurationError } from '../errors.js'
import { isDomainName } from './domain.js'
import type {
  AdmissionAuthorizeCallbacks,
  AdmissionConfig,
  ResolvedAdmissionConfig,
} from './types.js'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function fail(field: string, message: string): never {
  throw new InvalidConfigurationError(field, `account_kit: admission ${message}`)
}

/**
 * Validates the admission config. Throws at boot for a config with no requirement, a malformed
 * domain, or a missing `authorize` callback.
 */
export function defineAdmission(config: AdmissionConfig): ResolvedAdmissionConfig {
  if (!isObject(config)) fail('admission', 'config must be an object')
  const { domain, invitation, approval, onAdmissionEvent } = config
  if (domain === undefined && invitation === undefined && approval === undefined)
    fail('admission', 'needs at least one of domain, invitation or approval')

  let resolvedDomain: ResolvedAdmissionConfig['domain'] = null
  if (domain !== undefined) {
    if (!isObject(domain)) fail('admission.domain', 'domain must be an object')
    if (!Array.isArray(domain.allowed) || domain.allowed.length === 0)
      fail('admission.domain.allowed', 'domain.allowed must be a non-empty array')
    for (const entry of domain.allowed)
      if (!isDomainName(entry))
        fail(
          'admission.domain.allowed',
          `domain.allowed entry ${JSON.stringify(entry)} must be a lowercase ASCII domain`
        )
    if (domain.includeSubdomains !== undefined && typeof domain.includeSubdomains !== 'boolean')
      fail('admission.domain.includeSubdomains', 'domain.includeSubdomains must be a boolean')
    resolvedDomain = {
      allowed: Object.freeze([...domain.allowed]),
      includeSubdomains: domain.includeSubdomains ?? false,
    }
  }

  if (invitation !== undefined && (!isObject(invitation) || invitation.required !== true))
    fail('admission.invitation', 'invitation must be { required: true }; omit it to disable')

  let resolvedApproval: ResolvedAdmissionConfig['approval'] = null
  if (approval !== undefined) {
    if (!isObject(approval) || approval.required !== true)
      fail('admission.approval', 'approval must have required: true; omit it to disable')
    const authorize = approval.authorize
    if (!isObject(authorize))
      fail('admission.approval.authorize', 'approval.authorize must be an object')
    for (const name of ['decide', 'list'] as const)
      if (typeof authorize[name] !== 'function')
        fail(
          `admission.approval.authorize.${name}`,
          `approval.authorize.${name} must be a function`
        )
    resolvedApproval = { authorize: authorize as unknown as AdmissionAuthorizeCallbacks }
  }

  if (onAdmissionEvent !== undefined && typeof onAdmissionEvent !== 'function')
    fail('admission.onAdmissionEvent', 'onAdmissionEvent must be a function')

  return {
    domain: resolvedDomain,
    invitation: invitation !== undefined,
    approval: resolvedApproval,
    ...(onAdmissionEvent
      ? { onAdmissionEvent: onAdmissionEvent as ResolvedAdmissionConfig['onAdmissionEvent'] }
      : {}),
  }
}
