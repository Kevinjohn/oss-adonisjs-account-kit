// Validates the socialAuthentication option and its configured providers.
import { isSocialProviderName } from './social_providers.js'
import type { AccountKitConfig, Capability, SocialProviderName } from './types.js'

export function validateSocialAuthentication(
  config: AccountKitConfig,
  enabled: readonly Capability[]
): void {
  if (!enabled.includes('emailVerification'))
    throw new Error(
      'account_kit: socialAuthentication requires emailVerification for unverified provider email'
    )
  const social = config.socialAuthentication
  if (!social || !social.providers || !config.registration || !config.authentication)
    throw new Error(
      'account_kit: socialAuthentication requires providers, registration and authentication'
    )
  const names = Object.keys(social.providers)
  if (names.length === 0 || names.some((name) => !isSocialProviderName(name)))
    throw new Error('account_kit: socialAuthentication supports google and github only')
  for (const name of names) {
    const provider = social.providers[name as SocialProviderName]
    if (typeof provider?.authorizationUrl !== 'function' || typeof provider.resolve !== 'function')
      throw new Error(`account_kit: socialAuthentication.providers.${name} must use Ally`)
    if (
      provider.verifyFreshAuthentication !== undefined &&
      typeof provider.verifyFreshAuthentication !== 'function'
    )
      throw new Error(
        `account_kit: socialAuthentication.providers.${name}.verifyFreshAuthentication must be a function`
      )
  }
}
