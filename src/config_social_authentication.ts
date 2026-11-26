// Validates the socialAuthentication option and its configured providers.
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from './errors.ts'
import { isSocialProviderName } from './social_providers.ts'
import type { AccountKitConfig, Capability, SocialProviderName } from './types.ts'

export function assertSocialAuthenticationConfig(
  config: AccountKitConfig,
  enabled: readonly Capability[]
): void {
  if (!enabled.includes('emailVerification'))
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'socialAuthentication',
      'account_kit: socialAuthentication requires emailVerification for unverified provider email'
    )
  const social = config.socialAuthentication
  if (!social || !social.providers || !config.registration || !config.authentication)
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'socialAuthentication',
      'account_kit: socialAuthentication requires providers, registration and authentication'
    )
  if (social.acceptLink !== undefined && typeof social.acceptLink !== 'function')
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'socialAuthentication.acceptLink',
      'account_kit: socialAuthentication.acceptLink must be a function'
    )
  const names = Object.keys(social.providers)
  if (names.length === 0 || names.some((name) => !isSocialProviderName(name)))
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
      'socialAuthentication.providers',
      'account_kit: socialAuthentication supports google and github only'
    )
  for (const name of names) {
    const provider = social.providers[name as SocialProviderName]
    if (typeof provider?.authorizationUrl !== 'function' || typeof provider.resolve !== 'function')
      throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
        `socialAuthentication.providers.${name}`,
        `account_kit: socialAuthentication.providers.${name} must use Ally`
      )
    if (
      provider.verifyFreshAuthentication !== undefined &&
      typeof provider.verifyFreshAuthentication !== 'function'
    )
      throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
        `socialAuthentication.providers.${name}.verifyFreshAuthentication`,
        `account_kit: socialAuthentication.providers.${name}.verifyFreshAuthentication must be a function`
      )
  }
}
