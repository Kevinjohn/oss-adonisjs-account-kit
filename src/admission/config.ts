// Validates `config/admission.ts` at boot.
import { RuntimeException } from '@adonisjs/core/exceptions'
import { isDomainName } from './domain.js'
import type {
  AdmissionAuthorizeCallbacks,
  AdmissionConfig,
  ResolvedAdmissionConfig,
} from './types.js'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function fail(message: string): never {
  throw new RuntimeException(`account_kit: admission ${message}`)
}

/**
 * Validates the admission config. Throws at boot for a config with no requirement, a malformed
 * domain, or a missing `authorize` callback.
 */
export function defineAdmission(config: AdmissionConfig): ResolvedAdmissionConfig {
  if (!isObject(config)) fail('config must be an object')
  const { domain, invitation, approval, onAdmissionEvent } = config
  if (domain === undefined && invitation === undefined && approval === undefined)
    fail('needs at least one of domain, invitation or approval')

  let resolvedDomain: ResolvedAdmissionConfig['domain'] = null
  if (domain !== undefined) {
    if (!isObject(domain)) fail('domain must be an object')
    if (!Array.isArray(domain.allowed) || domain.allowed.length === 0)
      fail('domain.allowed must be a non-empty array')
    for (const entry of domain.allowed)
      if (!isDomainName(entry))
        fail(`domain.allowed entry ${JSON.stringify(entry)} must be a lowercase ASCII domain`)
    if (domain.includeSubdomains !== undefined && typeof domain.includeSubdomains !== 'boolean')
      fail('domain.includeSubdomains must be a boolean')
    resolvedDomain = {
      allowed: Object.freeze([...domain.allowed]),
      includeSubdomains: domain.includeSubdomains ?? false,
    }
  }

  if (invitation !== undefined && (!isObject(invitation) || invitation.required !== true))
    fail('invitation must be { required: true }; omit it to disable')

  let resolvedApproval: ResolvedAdmissionConfig['approval'] = null
  if (approval !== undefined) {
    if (!isObject(approval) || approval.required !== true)
      fail('approval must have required: true; omit it to disable')
    const authorize = approval.authorize
    if (!isObject(authorize)) fail('approval.authorize must be an object')
    for (const name of ['decide', 'list'] as const)
      if (typeof authorize[name] !== 'function')
        fail(`approval.authorize.${name} must be a function`)
    resolvedApproval = { authorize: authorize as unknown as AdmissionAuthorizeCallbacks }
  }

  if (onAdmissionEvent !== undefined && typeof onAdmissionEvent !== 'function')
    fail('onAdmissionEvent must be a function')

  return {
    domain: resolvedDomain,
    invitation: invitation !== undefined,
    approval: resolvedApproval,
    ...(onAdmissionEvent
      ? { onAdmissionEvent: onAdmissionEvent as ResolvedAdmissionConfig['onAdmissionEvent'] }
      : {}),
  }
}
