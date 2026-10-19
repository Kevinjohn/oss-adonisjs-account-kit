import { isSocialProviderName } from '../social_providers.js'
import type { ManagedRoutesOptions } from './managed_types.js'

/** Reject managed route options that cannot work with the selected guard or providers. */
export function assertManagedRoutesOptions<Credential>(
  options: ManagedRoutesOptions<Credential>
): void {
  if (
    options.guard.strategy === 'access_tokens' &&
    options.enabled.some(
      (capability) =>
        capability === 'authentication' ||
        capability === 'registration' ||
        capability === 'magicLinkLogin' ||
        capability === 'socialAuthentication'
    ) &&
    !options.guard.publicCredential
  )
    throw new Error('Managed access-token routes require publicCredential')
  if (
    options.enabled.includes('socialAuthentication') &&
    (!options.extensions?.social ||
      !options.extensions.social.providers.length ||
      options.extensions.social.providers.some((name) => !isSocialProviderName(name)) ||
      new Set(options.extensions.social.providers).size !==
        options.extensions.social.providers.length)
  )
    throw new Error('Managed social routes require a selected Google or GitHub provider inventory')
}
