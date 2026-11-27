// Validates `config/admission.ts` at boot.
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from '../errors.ts'
import { isDomainName } from './domain.ts'
import type {
  AdmissionAuthorizeCallbacks,
  AdmissionCallbacks,
  AdmissionConfig,
  ResolvedAdmissionConfig,
} from './types.ts'

/** A config `defineConfig` built, keeping its input for the checks that need the callbacks. */
class DefinedAdmissionConfig implements ResolvedAdmissionConfig {
  declare domain: ResolvedAdmissionConfig['domain']
  declare invitation: boolean
  declare approval: ResolvedAdmissionConfig['approval']
  declare onAdmissionNotification?: ResolvedAdmissionConfig['onAdmissionNotification']
  #input: AdmissionConfig

  constructor(resolved: ResolvedAdmissionConfig, input: AdmissionConfig) {
    Object.assign(this, resolved)
    this.#input = input
  }

  static inputOf(config: ResolvedAdmissionConfig): AdmissionConfig | undefined {
    return config instanceof DefinedAdmissionConfig ? config.#input : undefined
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function fail(field: string, message: string): never {
  throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(field, `account_kit: admission ${message}`)
}

/**
 * Validates the admission config. Throws at boot for a config with no requirement, a malformed
 * domain, or an invalid `authorize` callback. A missing `approval.authorize` may come from
 * `AdmissionCallbackConfiguration`; it is checked when the admission service is first resolved.
 *
 * @example
 * ```ts
 * import { defineConfig } from '@kevinjohn/adonisjs-account-kit/admission'
 *
 * export default defineConfig({ invitation: { required: true } })
 * ```
 */
export function defineConfig(config: AdmissionConfig): ResolvedAdmissionConfig {
  return new DefinedAdmissionConfig(checkAdmission(config, true), config)
}

/**
 * The admission config merged with the registered callbacks, with every `defineConfig` check
 * run on the result. A config `defineConfig` did not build is used as it is.
 */
export function resolveAdmissionConfig(
  config: ResolvedAdmissionConfig,
  callbacks: AdmissionCallbacks | undefined
): ResolvedAdmissionConfig {
  const input = DefinedAdmissionConfig.inputOf(config)
  if (!input) return config
  if (!callbacks) {
    checkAdmission(input, false)
    return config
  }
  if (typeof callbacks !== 'object' || callbacks === null)
    fail('callbacks', 'callbacks must be an object')
  const { approvalAuthorize, onAdmissionNotification } = callbacks
  if (approvalAuthorize !== undefined && input.approval?.authorize !== undefined)
    rejectDuplicateAdmissionSetting('approval.authorize')
  if (onAdmissionNotification !== undefined && input.onAdmissionNotification !== undefined)
    rejectDuplicateAdmissionSetting('onAdmissionNotification')
  return checkAdmission(
    {
      ...input,
      ...(input.approval !== undefined && approvalAuthorize !== undefined
        ? { approval: { ...input.approval, authorize: approvalAuthorize } }
        : {}),
      ...(onAdmissionNotification !== undefined ? { onAdmissionNotification } : {}),
    },
    false
  )
}

function rejectDuplicateAdmissionSetting(field: string): never {
  fail(
    `admission.${field}`,
    `${field} is set in both config/admission.ts and the registered callbacks`
  )
}

function checkAdmission(config: AdmissionConfig, deferCallbacks: boolean): ResolvedAdmissionConfig {
  if (!isObject(config)) fail('admission', 'config must be an object')
  const { domain, invitation, approval, onAdmissionNotification } = config
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
    if (!deferCallbacks || authorize !== undefined) {
      if (!isObject(authorize))
        fail('admission.approval.authorize', 'approval.authorize must be an object')
      for (const name of ['decide', 'list'] as const)
        if (typeof authorize[name] !== 'function')
          fail(
            `admission.approval.authorize.${name}`,
            `approval.authorize.${name} must be a function`
          )
    }
    resolvedApproval = { authorize: authorize as unknown as AdmissionAuthorizeCallbacks }
  }

  if (onAdmissionNotification !== undefined && typeof onAdmissionNotification !== 'function')
    fail('admission.onAdmissionNotification', 'onAdmissionNotification must be a function')

  return {
    domain: resolvedDomain,
    invitation: invitation !== undefined,
    approval: resolvedApproval,
    ...(onAdmissionNotification
      ? {
          onAdmissionNotification:
            onAdmissionNotification as ResolvedAdmissionConfig['onAdmissionNotification'],
        }
      : {}),
  }
}
