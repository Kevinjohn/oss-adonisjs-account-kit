import { test } from '@japa/runner'
import { defaultSetupChoices } from '../src/setup/defaults.js'
import { parseSetupChoices } from '../src/setup/parse.js'

test.group('setup choice parsing', () => {
  test('standard defaults require explicit invitation and social opt-in', ({ assert }) => {
    const choices = defaultSetupChoices()
    assert.notInclude(choices.features, 'invitations')
    assert.notInclude(choices.managed, 'invitations')
    assert.equal(choices.social.status, 'not-applicable')
    assert.equal(choices.mail.integration, 'adonisjs-mail')
  })

  test('semantic setup choices reject invalid registration, duration and abilities', ({
    assert,
  }) => {
    const choices = defaultSetupChoices()
    choices.policy.registration = 'typo' as never
    assert.throws(() => parseSetupChoices(choices), /policy.registration/)
    choices.policy.registration = 'open'
    choices.authentication = {
      strategy: 'access_tokens',
      guard: 'api',
      token: { revocation: true, lifetime: 'nonsense', abilities: ['*'] },
      applicationRouteRevocation: true,
    }
    assert.throws(() => parseSetupChoices(choices), /authentication.token.lifetime/)
    choices.authentication.token!.lifetime = '7d'
    choices.authentication.token!.abilities = ['']
    assert.throws(() => parseSetupChoices(choices), /authentication.token.abilities/)
  })

  test('rejects an invalid mode and an unsupported version', ({ assert }) => {
    const choices = defaultSetupChoices()
    assert.throws(
      () => parseSetupChoices({ ...choices, mode: 'typo' }),
      'mode: choose services or managed'
    )
    assert.throws(() => parseSetupChoices({ ...choices, version: 2 }), 'version: expected 1')
  })

  test('rejects an unknown authentication strategy and non-boolean password rules', ({
    assert,
  }) => {
    const choices = defaultSetupChoices()
    choices.authentication = {
      strategy: 'jwt' as never,
      guard: 'web',
      applicationRouteRevocation: true,
    }
    assert.throws(
      () => parseSetupChoices(choices),
      'authentication.strategy: choose session or access_tokens'
    )
    for (const key of ['letters', 'mixedCase', 'numbers', 'symbols'] as const) {
      const policy = defaultSetupChoices()
      policy.policy.password[key] = 'yes' as never
      assert.throws(() => parseSetupChoices(policy), `policy.password.${key}: expected a boolean`)
    }
  })
})
