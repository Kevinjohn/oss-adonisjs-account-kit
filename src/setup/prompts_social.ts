import { isSocialProviderName } from '../social_providers.js'
import type { SocialProviderName } from '../types.js'
import type { SetupChoices } from './types.js'

export async function collectSocialChoices(
  choices: SetupChoices,
  ask: (question: string) => Promise<string>,
  log: (message: string) => void
): Promise<void> {
  const socialInput = await ask(
    'Social providers to prepare, comma separated (google,github; blank for none)'
  )
  const social = socialInput.trim()
  if (social) {
    const providers = social.split(',').map((name) => name.trim())
    if (providers.some((name) => !isSocialProviderName(name)))
      throw new Error('social.providers: choose google and/or github')
    choices.social = {
      status: 'enabled',
      providers: [...new Set(providers)] as SocialProviderName[],
      callbackOriginEnv:
        (await ask('Social callback origin environment name (ACCOUNT_SOCIAL_ORIGIN)')) ||
        'ACCOUNT_SOCIAL_ORIGIN',
      callbackPath:
        (await ask('Social callback path with {provider} placeholder')) ||
        (choices.authentication?.strategy === 'access_tokens'
          ? '/auth/oauth/{provider}/callback'
          : `${choices.routePrefix}/auth/oauth/{provider}/callback`),
      credentials: {},
    }
    for (const provider of choices.social.providers) {
      choices.social.credentials[provider] = {
        clientIdEnv:
          (await ask(
            `${provider} client ID environment name (${provider.toUpperCase()}_CLIENT_ID)`
          )) || `${provider.toUpperCase()}_CLIENT_ID`,
        clientSecretEnv:
          (await ask(
            `${provider} client secret environment name (${provider.toUpperCase()}_CLIENT_SECRET)`
          )) || `${provider.toUpperCase()}_CLIENT_SECRET`,
      }
    }
    if (!choices.features.includes('socialAuthentication'))
      choices.features.push('socialAuthentication')
    if (choices.mode === 'managed' && !choices.managed.includes('socialAuthentication'))
      choices.managed.push('socialAuthentication')
    log('Selected providers require Ally console callbacks and deployment credentials')
  }
}
