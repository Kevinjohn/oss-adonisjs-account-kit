import { test } from '@japa/runner'
import { defaultSetupChoices } from '../src/setup/defaults.js'
import { parseSetupChoices } from '../src/setup/parse.js'
import { collectSetupChoices } from '../src/setup/prompts.js'
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
      'Additional registration fields': '[{"name":"fullName","type":"string","required":true}]',
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
})
