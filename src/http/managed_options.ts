import { isSocialProviderName } from '../social_providers.js'
import type { ManagedRoutesOptions } from './managed_types.js'
import { InvalidArgumentsException } from '@adonisjs/core/exceptions'

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
    throw new InvalidArgumentsException('Managed access-token routes require publicCredential')
  // Without it, logout would answer 204 and leave the bearer token valid.
  if (
    options.guard.strategy === 'access_tokens' &&
    options.enabled.includes('authentication') &&
    !options.guard.logoutCredential
  )
    throw new InvalidArgumentsException('Managed access-token logout requires logoutCredential')
  if (
    options.enabled.includes('socialAuthentication') &&
    (!options.extensions?.social ||
      !options.extensions.social.providers.length ||
      options.extensions.social.providers.some((name) => !isSocialProviderName(name)) ||
      new Set(options.extensions.social.providers).size !==
        options.extensions.social.providers.length)
  )
    throw new InvalidArgumentsException(
      'Managed social routes require a selected Google or GitHub provider inventory'
    )
}
