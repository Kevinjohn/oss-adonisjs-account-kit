import { test } from '@japa/runner'
import SetupAccountKit from '../commands/setup.js'
import { defaultSetupChoices } from '../src/setup/defaults.js'
import { parseSetupChoices } from '../src/setup/parse.js'

async function interactive(answers: Record<string, string> = {}) {
  return SetupAccountKit.prototype.interactiveChoices.call(
    { logger: { info() {} } } as unknown as SetupAccountKit,
    async (question) =>
      Object.entries(answers).find(([prefix]) => question.startsWith(prefix))?.[1] ?? ''
  )
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
})
