import { test } from '@japa/runner'
import { defaultSetupChoices } from '../src/setup/defaults.js'
import { validateSocial } from '../src/setup/validate_social.js'
import type { SetupChoices, SetupDiagnostic, SetupInspection } from '../src/setup/types.js'

const env = {
  ACCOUNT_SOCIAL_ORIGIN: 'https://app.example.test',
  GITHUB_CLIENT_ID: 'id',
  GITHUB_CLIENT_SECRET: 'secret',
}

const state = {
  installedPackages: ['@adonisjs/ally'],
  files: { 'config/ally.ts': 'export default {}' },
} as unknown as SetupInspection

/** Choices that validate cleanly with GitHub enabled; each test breaks exactly one thing. */
function socialChoices(): SetupChoices {
  const choices = defaultSetupChoices()
  choices.features = [
    'authentication',
    'registration',
    'emailVerification',
    'passwordReset',
    'socialAuthentication',
  ]
  choices.managed = [...choices.features]
  choices.social = {
    status: 'enabled',
    providers: ['github'],
    callbackOriginEnv: 'ACCOUNT_SOCIAL_ORIGIN',
    callbackPath: '/account/auth/oauth/{provider}/callback',
    credentials: {
      github: { clientIdEnv: 'GITHUB_CLIENT_ID', clientSecretEnv: 'GITHUB_CLIENT_SECRET' },
    },
  }
  return choices
}

function run(choices: SetupChoices) {
  const diagnostics: SetupDiagnostic[] = []
  validateSocial(diagnostics, choices, state, false, env)
  return diagnostics
}

function social(choices: SetupChoices) {
  if (choices.social.status !== 'enabled') throw new Error('social must be enabled')
  return choices.social
}

test.group('setup social validation', () => {
  test('a complete selection produces no diagnostics', ({ assert }) => {
    assert.deepEqual(run(socialChoices()), [])
  })

  test('rejects an empty, unknown or repeated provider list', ({ assert }) => {
    for (const providers of [[], ['twitter'], ['github', 'github']]) {
      const choices = socialChoices()
      social(choices).providers = providers as never
      if (providers[0] === 'twitter') social(choices).credentials = {}
      const fields = run(choices).map(({ field }) => field)
      assert.include(fields, 'social.providers', JSON.stringify(providers))
    }
  })

  test('requires the socialAuthentication feature and a selected guard', ({ assert }) => {
    const choices = socialChoices()
    choices.features = choices.features.filter((name) => name !== 'socialAuthentication')
    choices.authentication = null
    const diagnostics = run(choices)
    assert.include(
      diagnostics.map(({ message }) => message),
      'Selected social providers require socialAuthentication'
    )
    assert.include(
      diagnostics.map(({ message }) => message),
      'Social authentication requires a selected guard'
    )
  })

  test('rejects a callback path that is relative, placeholder-less or unsafe', ({ assert }) => {
    for (const callbackPath of [
      'auth/{provider}/callback',
      '/account/auth/oauth/github/callback',
      '/account/auth/{provider}?x=1',
      '/account/auth/{provider}#x',
      '/account/../{provider}',
      '/account\\{provider}',
      '//account/{provider}',
    ]) {
      const choices = socialChoices()
      choices.authentication!.strategy = 'access_tokens'
      social(choices).callbackPath = callbackPath
      assert.include(
        run(choices).map(({ message }) => message),
        'Use a safe absolute path containing {provider}',
        callbackPath
      )
    }
  })

  test('requires credential variable names for every selected provider', ({ assert }) => {
    for (const credentials of [
      {},
      { github: { clientIdEnv: 'https://x', clientSecretEnv: 'GITHUB_CLIENT_SECRET' } },
      { github: { clientIdEnv: 'GITHUB_CLIENT_ID', clientSecretEnv: 'lower' } },
    ]) {
      const choices = socialChoices()
      social(choices).credentials = credentials as never
      const diagnostics = run(choices)
      assert.deepEqual(
        diagnostics.map(({ field, message }) => [field, message]),
        [
          [
            'social.credentials.github',
            'Provide credential environment variable names for this provider',
          ],
        ],
        JSON.stringify(credentials)
      )
    }
  })

  test('rejects credential references for a provider that is not selected', ({ assert }) => {
    const choices = socialChoices()
    social(choices).credentials.google = {
      clientIdEnv: 'GOOGLE_CLIENT_ID',
      clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    }
    assert.deepEqual(
      run(choices).map(({ field, message }) => [field, message]),
      [['social.credentials.google', 'Disabled providers must not carry credential references']]
    )
  })

  test('socialAuthentication without providers is an error', ({ assert }) => {
    const choices = socialChoices()
    choices.social = { status: 'not-applicable', reason: 'none selected' }
    assert.deepEqual(
      run(choices).map(({ field, message }) => [field, message]),
      [['social', 'Enabled socialAuthentication requires selected providers']]
    )
  })
})
