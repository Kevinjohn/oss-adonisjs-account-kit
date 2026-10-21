import { isSocialProviderName } from '../social_providers.js'
import type { SocialProviderName } from '../types.js'
import type { GuardStrategy, SetupChoices } from './types.js'

/** Keep the social sign-in questions and their saved-choice behavior together. */
export async function collectSocialChoices(
  choices: SetupChoices,
  ask: (question: string) => Promise<string>,
  log: (message: string) => void,
  savedRoutePrefix: string,
  savedStrategy: GuardStrategy | undefined
): Promise<void> {
  const socialEnabled = choices.features.includes('socialAuthentication')
  if (!socialEnabled) {
    choices.social = { status: 'not-applicable', reason: 'Social sign-in not selected' }
    choices.managed = choices.managed.filter((feature) => feature !== 'socialAuthentication')
  }
  const currentProviders =
    choices.social.status === 'enabled' ? choices.social.providers.join(', ') : 'none'
  const socialInput = await ask(
    `Social providers to prepare, comma separated (google,github; current: ${currentProviders}; none to disable)`
  )
  const social = socialInput.trim()
  const previous = choices.social.status === 'enabled' ? choices.social : null
  if (social.toLowerCase() === 'none') {
    choices.social = { status: 'not-applicable', reason: 'Social sign-in not selected' }
    choices.features = choices.features.filter((feature) => feature !== 'socialAuthentication')
    choices.managed = choices.managed.filter((feature) => feature !== 'socialAuthentication')
  } else if (social || (socialEnabled && previous)) {
    const providers = social
      ? social
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
      : previous!.providers
    if (providers.some((name) => !isSocialProviderName(name)))
      throw new Error('social.providers: choose from google, github')
    choices.social = {
      status: 'enabled',
      providers: [...new Set(providers)] as SocialProviderName[],
      callbackOriginEnv: '',
      callbackPath: '',
      credentials: {},
    }
    choices.social.callbackOriginEnv =
      (await ask(
        `Social callback origin environment name (${previous?.callbackOriginEnv ?? 'ACCOUNT_SOCIAL_ORIGIN'})`
      )) ||
      previous?.callbackOriginEnv ||
      'ACCOUNT_SOCIAL_ORIGIN'
    const strategy = choices.authentication?.strategy
    // A saved session path embeds the route prefix, so keep it only while both are unchanged.
    const savedCallbackPath =
      strategy === savedStrategy &&
      (strategy === 'access_tokens' || choices.routePrefix === savedRoutePrefix)
        ? previous?.callbackPath
        : undefined
    const defaultCallbackPath =
      savedCallbackPath ||
      (strategy === 'access_tokens'
        ? '/auth/oauth/{provider}/callback'
        : `${choices.routePrefix}/auth/oauth/{provider}/callback`)
    choices.social.callbackPath =
      (await ask(`Social callback path with {provider} placeholder (${defaultCallbackPath})`)) ||
      defaultCallbackPath
    for (const provider of choices.social.providers) {
      const existingCredentials = previous?.credentials[provider]
      choices.social.credentials[provider] = {
        clientIdEnv:
          (await ask(
            `${provider} client ID environment name (${existingCredentials?.clientIdEnv ?? `${provider.toUpperCase()}_CLIENT_ID`})`
          )) ||
          existingCredentials?.clientIdEnv ||
          `${provider.toUpperCase()}_CLIENT_ID`,
        clientSecretEnv:
          (await ask(
            `${provider} client secret environment name (${existingCredentials?.clientSecretEnv ?? `${provider.toUpperCase()}_CLIENT_SECRET`})`
          )) ||
          existingCredentials?.clientSecretEnv ||
          `${provider.toUpperCase()}_CLIENT_SECRET`,
      }
    }
    if (social && !choices.features.includes('socialAuthentication'))
      choices.features.push('socialAuthentication')
    if (social && choices.mode === 'managed' && !choices.managed.includes('socialAuthentication'))
      choices.managed.push('socialAuthentication')
    log('Selected providers require Ally console callbacks and deployment credentials')
  }
  if (!choices.features.includes('socialAuthentication'))
    choices.social = { status: 'not-applicable', reason: 'Social sign-in not selected' }
}
