import type { SetupChoices } from './types.js'
import { requiredEnvHelperLines } from './generated_env_helpers.js'

export function allyConfigSource(choices: SetupChoices): string {
  if (choices.social.status !== 'enabled') throw new Error('Social providers are not selected')
  const social = choices.social
  const origin = social.callbackOriginEnv
  return [
    "import { defineConfig, services } from '@adonisjs/ally'",
    "import type { InferSocialProviders } from '@adonisjs/ally/types'",
    '',
    ...requiredEnvHelperLines,
    '',
    'const allyConfig = defineConfig({',
    ...social.providers.map((provider) => {
      const refs = social.credentials[provider]!
      const path = social.callbackPath.replace('{provider}', provider)
      return [
        `  ${provider}: services.${provider}({`,
        `    clientId: requiredEnv(${JSON.stringify(refs.clientIdEnv)}),`,
        `    clientSecret: requiredEnv(${JSON.stringify(refs.clientSecretEnv)}),`,
        `    callbackUrl: new URL(${JSON.stringify(path)}, requiredEnv(${JSON.stringify(origin)})).toString(),`,
        ...(provider === 'github' ? ["    scopes: ['user:email'],"] : []),
        '  }),',
      ].join('\n')
    }),
    '})',
    '',
    "declare module '@adonisjs/ally/types' {",
    '  interface SocialProviders extends InferSocialProviders<typeof allyConfig> {}',
    '}',
    '',
    'export default allyConfig',
    '',
  ].join('\n')
}
