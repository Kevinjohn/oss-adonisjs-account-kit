import { test } from '@japa/runner'
import { defaultSetupChoices } from '../src/setup/defaults.js'
import { parseSetupChoices } from '../src/setup/parse.js'
import { collectSetupChoices } from '../src/setup/prompts.js'
import type { SetupChoices } from '../src/setup/types.js'
import { interactive } from './helpers/interactive_choices.js'

async function collectWithTrace(answers: Record<string, string>) {
  const questions: string[] = []
  const choices = await collectSetupChoices(
    async (question) => {
      questions.push(question)
      return Object.entries(answers).find(([prefix]) => question.startsWith(prefix))?.[1] ?? ''
    },
    () => {}
  )
  return { choices, questions }
}

function collectFromSavedChoices(
  ask: (question: string) => Promise<string>,
  log: (message: string) => void,
  initialChoices: SetupChoices
) {
  return collectSetupChoices(ask, log, initialChoices)
}

function savedNonDefaultChoices(): SetupChoices {
  const choices = defaultSetupChoices()
  choices.features = [
    'registration',
    'authentication',
    'emailVerification',
    'passwordReset',
    'emailPasswordManagement',
    'invitations',
    'magicLinkLogin',
    'socialAuthentication',
  ]
  choices.managed = ['authentication', 'passwordReset', 'invitations']
  choices.managedExcept = ['auth.passwordReset.request']
  choices.routePrefix = '/members'
  choices.user.table = 'account_members'
  choices.user.adapter = 'custom'
  choices.user.idType = 'uuid'
  choices.authentication = {
    strategy: 'access_tokens',
    guard: 'api',
    applicationRouteRevocation: true,
    token: { revocation: true, lifetime: '30d', abilities: ['account:read'] },
  }
  choices.mail.integration = 'custom'
  choices.mail.delivery = 'durable'
  choices.mail.senderEnv = null
  choices.mail.transportEnv = null
  choices.mail.appName = 'Members portal'
  choices.mail.backendOriginEnv = 'ACCOUNT_BACKEND_URL'
  choices.mail.frontendOriginEnv = 'ACCOUNT_FRONTEND_URL'
  choices.mail.destinations = {
    emailVerification: 'members/verify',
    passwordReset: 'members/recover',
    invitation: 'members/invite',
    emailChange: 'members/change-email',
    magicLink: 'members/sign-in-link',
  }
  choices.mail.durableWorkerVerified = true
  choices.policy.password = {
    minLength: 14,
    maxLength: 64,
    letters: true,
    mixedCase: true,
    numbers: true,
    symbols: true,
    minScore: 2,
  }
  choices.policy.invitationPermissionHook = true
  choices.policy.accessRestrictionHook = true
  choices.social = {
    status: 'enabled',
    providers: ['google'],
    callbackOriginEnv: 'ACCOUNT_SOCIAL_URL',
    callbackPath: '/members/oauth/{provider}/callback',
    credentials: {
      google: { clientIdEnv: 'MEMBERS_GOOGLE_ID', clientSecretEnv: 'MEMBERS_GOOGLE_SECRET' },
    },
  }
  return choices
}

test.group('setup prompt values', () => {
  for (const [field, question] of [
    ['mode', 'Consumption mode'],
    ['user.adapter', 'User adapter'],
    ['user.idType', 'Physical id type'],
    ['authentication.strategy', 'Existing guard strategy'],
    ['mail.integration', 'Delivery integration'],
    ['mail.delivery', 'Delivery guarantee'],
    ['policy.registration', 'Registration policy'],
    ['policy.unverifiedActions', 'Allowed actions before verification'],
  ] as const) {
    test(`rejects an invalid nonempty ${field} answer`, async ({ assert }) => {
      await assert.rejects(() => interactive({ [question]: 'invalid-value' }), new RegExp(field))
    })
  }

  test('rejects an invalid yes/no answer instead of treating it as no', async ({ assert }) => {
    await assert.rejects(
      () => interactive({ 'Secure session cookie': 'maybe' }),
      /Secure session cookie.*choose yes or no/
    )
  })

  test('trims valid answers and preserves conventional defaults', async ({ assert }) => {
    const choices = await interactive({
      'Consumption mode': ' managed ',
      'Registration policy': ' closed ',
      'Trusted frontend origin': ' MY_FRONTEND_URL ',
    })
    assert.equal(choices.mode, 'managed')
    assert.equal(choices.policy.registration, 'closed')
    assert.equal(choices.mail.frontendOriginEnv, 'MY_FRONTEND_URL')
    assert.deepEqual(parseSetupChoices(choices), choices)

    const defaults = await interactive({ 'Enabled services': '   ' })
    assert.equal(defaults.mode, 'managed')
    assert.equal(defaults.policy.registration, 'open')
    assert.deepEqual(defaults.features, defaultSetupChoices().features)
    assert.isTrue(defaults.policy.verificationRequired)
    assert.equal(defaults.mail.frontendOriginEnv, 'FRONTEND_URL')
    assert.equal(defaultSetupChoices().mail.frontendOriginEnv, 'FRONTEND_URL')
  })

  test('interactive and JSON choices both reject unknown mode and registration', async ({
    assert,
  }) => {
    await assert.rejects(() => interactive({ 'Consumption mode': 'unknown' }), /mode/)
    const invalidMode = { ...defaultSetupChoices(), mode: 'unknown' }
    assert.throws(() => parseSetupChoices(invalidMode), /mode/)

    await assert.rejects(
      () => interactive({ 'Registration policy': 'unknown' }),
      /policy.registration/
    )
    const invalidRegistration = defaultSetupChoices()
    Object.assign(invalidRegistration.policy, { registration: 'unknown' })
    assert.throws(() => parseSetupChoices(invalidRegistration), /policy.registration/)
  })

  test('interactive token answers produce complete parseable choices including invitation destination', async ({
    assert,
  }) => {
    const answers: Record<string, string> = {
      'Enabled services': 'authentication,invitations',
      'Managed endpoint groups': 'authentication,invitations',
      'Managed endpoint exclusions': 'auth.invitation.inspect',
      'Existing guard strategy': 'access_tokens',
      'Existing guard name': 'api',
      'Token revocation': 'yes',
      'Application-owned protected': 'yes',
      'Delivery integration': 'custom',
      'invitation relative': 'invites/accept',
      'Additional profile fields for registration, invitations, email changes or social sign-in':
        '[{"name":"fullName","type":"string","required":true}]',
      'Application invitation permission': 'yes',
    }
    const choices = await interactive(answers)
    assert.equal(choices.authentication?.strategy, 'access_tokens')
    assert.deepEqual(choices.managedExcept, ['auth.invitation.inspect'])
    assert.isFalse(Object.hasOwn(choices.authentication!, 'session'))
    assert.equal(choices.mail.destinations.invitation, 'invites/accept')
    assert.lengthOf(choices.policy.registrationFields, 1)
    assert.deepEqual(parseSetupChoices(choices), choices)
  })

  test('services without email flows do not ask mail or origin questions', async ({ assert }) => {
    const { choices, questions } = await collectWithTrace({
      'Consumption mode': 'services',
      'Enabled services': 'authentication',
    })

    assert.deepEqual(choices.features, ['authentication'])
    assert.equal(choices.mode, 'services')
    assert.equal(choices.mail.integration, defaultSetupChoices().mail.integration)
    assert.equal(choices.mail.delivery, defaultSetupChoices().mail.delivery)
    assert.deepEqual(parseSetupChoices(choices), choices)
    assert.deepEqual(
      questions.filter((question) =>
        /^(Delivery integration|Delivery guarantee|Application queue worker|Mail sender|Mail transport|Application name|Trusted backend origin|Trusted frontend origin)|relative frontend path/.test(
          question
        )
      ),
      []
    )
  })

  test('only prompts for destinations used by selected email flows', async ({ assert }) => {
    for (const [features, expected] of [
      ['passwordReset', ['passwordReset']],
      ['passwordReset,emailPasswordManagement', ['passwordReset', 'emailChange']],
    ] as const) {
      const { choices, questions } = await collectWithTrace({ 'Enabled services': features })
      const destinations = questions
        .map((question) => /^([A-Za-z]+) relative frontend path/.exec(question)?.[1])
        .filter((name): name is string => name !== undefined)

      assert.deepEqual(destinations, expected)
      assert.deepEqual(parseSetupChoices(choices), choices)
    }
  })

  test('blank answers retain applicable saved values while one answer changes', async ({
    assert,
  }) => {
    const saved = savedNonDefaultChoices()
    const questions: string[] = []
    const choices = await collectFromSavedChoices(
      async (question) => {
        questions.push(question)
        return question.startsWith('New-password minimum length') ? '16' : ''
      },
      () => {},
      saved
    )
    const expected = structuredClone(saved)
    expected.policy.password.minLength = 16

    assert.deepEqual(choices, expected)
    assert.isTrue(questions.some((question) => question.startsWith('Social callback origin')))
    assert.isTrue(questions.some((question) => question.startsWith('google client ID')))
    assert.isTrue(questions.some((question) => question.startsWith('google client secret')))
    assert.deepEqual(parseSetupChoices(choices), choices)
  })

  test('disabling capabilities clears their stale choices', async ({ assert }) => {
    const saved = savedNonDefaultChoices()
    saved.policy.registrationFields = [{ name: 'legacyProfile', type: 'string', required: false }]
    const questions: string[] = []
    const answers = {
      'Consumption mode': 'services',
      'Enabled services': 'authentication',
    }
    const choices = await collectFromSavedChoices(
      async (question) => {
        questions.push(question)
        return Object.entries(answers).find(([prefix]) => question.startsWith(prefix))?.[1] ?? ''
      },
      () => {},
      saved
    )

    assert.deepEqual(choices.features, ['authentication'])
    assert.deepEqual(choices.managed, [])
    assert.equal(choices.mail.integration, defaultSetupChoices().mail.integration)
    assert.equal(choices.mail.delivery, defaultSetupChoices().mail.delivery)
    assert.deepEqual(choices.mail.destinations, defaultSetupChoices().mail.destinations)
    assert.equal(choices.policy.registration, 'closed')
    assert.deepEqual(choices.policy.registrationFields, [])
    assert.isFalse(choices.policy.verificationRequired)
    assert.deepEqual(choices.policy.unverifiedActions, [])
    assert.equal(choices.policy.invitationPermissionHook, false)
    assert.equal(choices.social.status, 'not-applicable')
    assert.isFalse(questions.some((question) => question.startsWith('Registration policy')))
    assert.notInclude(
      questions,
      'Additional profile fields for registration, invitations, email changes or social sign-in as JSON array (current: [{"name":"legacyProfile","type":"string","required":false}])'
    )
    assert.isFalse(questions.some((question) => question.startsWith('Require verified email')))
    assert.deepEqual(parseSetupChoices(choices), choices)
  })

  test('newly enabled email flows receive defaults without replacing saved destinations', async ({
    assert,
  }) => {
    const saved = defaultSetupChoices()
    saved.features = ['passwordReset']
    saved.managed = ['passwordReset']
    saved.mail.integration = 'custom'
    saved.mail.senderEnv = null
    saved.mail.transportEnv = null
    saved.mail.destinations = { passwordReset: 'members/recover' }
    const choices = await collectFromSavedChoices(
      async (question) =>
        question.startsWith('Enabled services') ? 'passwordReset,emailPasswordManagement' : '',
      () => {},
      saved
    )

    assert.equal(choices.mail.destinations.passwordReset, 'members/recover')
    assert.equal(choices.mail.destinations.emailChange, 'account/email-change')
    assert.deepEqual(parseSetupChoices(choices), choices)
  })

  test('profile fields stay enabled for every capability that consumes registration data', async ({
    assert,
  }) => {
    for (const feature of [
      'invitations',
      'emailPasswordManagement',
      'socialAuthentication',
    ] as const) {
      const saved = savedNonDefaultChoices()
      saved.features = [feature]
      saved.managed = []
      saved.policy.registrationFields = [{ name: 'fullName', type: 'string', required: true }]
      const choices = await collectFromSavedChoices(
        async () => '',
        () => {},
        saved
      )

      assert.deepEqual(choices.policy.registrationFields, saved.policy.registrationFields)
      assert.deepEqual(parseSetupChoices(choices), choices)
    }
  })

  test('fresh wizard defaults managed groups to newly selected services', async ({ assert }) => {
    const { choices } = await collectWithTrace({ 'Enabled services': 'invitations' })

    assert.deepEqual(choices.managed, ['invitations'])
  })

  test('disabling social sign-in clears exclusions for its routes', async ({ assert }) => {
    const saved = savedNonDefaultChoices()
    saved.managedExcept = ['auth.oauth.redirect']
    const choices = await collectFromSavedChoices(
      async (question) => (question.startsWith('Social providers to prepare') ? 'none' : ''),
      () => {},
      saved
    )

    assert.deepEqual(choices.managedExcept, [])
    assert.deepEqual(parseSetupChoices(choices), choices)
  })

  test('social provider lists ignore empty comma-separated values', async ({ assert }) => {
    for (const input of ['google,', 'google,,github']) {
      const saved = savedNonDefaultChoices()
      const choices = await collectFromSavedChoices(
        async (question) => (question.startsWith('Social providers to prepare') ? input : ''),
        () => {},
        saved
      )

      assert.deepInclude(choices.social, {
        status: 'enabled',
        providers: input === 'google,' ? ['google'] : ['google', 'github'],
      })
      assert.deepEqual(parseSetupChoices(choices), choices)
    }
  })

  test('interactive provider selection does not duplicate an already selected social group', async ({
    assert,
  }) => {
    const answers: Record<string, string> = {
      'Enabled services':
        'authentication,registration,emailVerification,passwordReset,socialAuthentication',
      'Managed endpoint groups': 'authentication,socialAuthentication',
      'Existing guard strategy': 'access_tokens',
      'Existing guard name': 'api',
      'Token revocation': 'yes',
      'Application-owned protected': 'yes',
      'Delivery integration': 'custom',
      'Application restricted-account': 'yes',
      'Social providers to prepare': 'google',
    }
    const choices = await interactive(answers)
    assert.equal(choices.features.filter((name) => name === 'socialAuthentication').length, 1)
    assert.equal(choices.managed.filter((name) => name === 'socialAuthentication').length, 1)
    assert.doesNotThrow(() => parseSetupChoices(choices))
  })

  test('social sign-in without ordinary registration keeps an application policy', async ({
    assert,
  }) => {
    const saved = savedNonDefaultChoices()
    saved.features = ['authentication', 'socialAuthentication']
    saved.managed = ['authentication', 'socialAuthentication']
    saved.managedExcept = []
    saved.policy.registration = 'application'
    const questions: string[] = []
    const choices = await collectFromSavedChoices(
      async (question) => {
        questions.push(question)
        return ''
      },
      () => {},
      saved
    )

    assert.equal(choices.policy.registration, 'application')
    assert.isTrue(questions.some((question) => question.startsWith('Registration policy')))
  })

  test('a changed route prefix replaces a saved session callback path', async ({ assert }) => {
    const saved = savedNonDefaultChoices()
    saved.authentication = defaultSetupChoices().authentication
    const social = saved.social as Extract<SetupChoices['social'], { status: 'enabled' }>
    social.callbackPath = '/members/auth/oauth/{provider}/callback'
    const answers: Record<string, string> = { 'Managed route prefix': '/auth' }
    const ask = async (question: string) =>
      Object.entries(answers).find(([prefix]) => question.startsWith(prefix))?.[1] ?? ''

    const moved = await collectFromSavedChoices(ask, () => {}, saved)
    assert.deepInclude(moved.social, { callbackPath: '/auth/auth/oauth/{provider}/callback' })

    delete answers['Managed route prefix']
    const kept = await collectFromSavedChoices(ask, () => {}, saved)
    assert.deepInclude(kept.social, { callbackPath: '/members/auth/oauth/{provider}/callback' })
  })
})
