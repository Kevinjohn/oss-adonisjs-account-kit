import { test } from '@japa/runner'
import { buildDefaultSetupChoices } from '../src/setup/defaults.js'
import { requireSetupChoices } from '../src/setup/parse.js'

test.group('setup choice parsing', () => {
  test('standard defaults require explicit invitation and social opt-in', ({ assert }) => {
    const choices = buildDefaultSetupChoices()
    assert.notInclude(choices.features, 'invitations')
    assert.notInclude(choices.managed, 'invitations')
    assert.equal(choices.social.status, 'not-applicable')
    assert.equal(choices.mail.integration, 'adonisjs-mail')
  })

  test('semantic setup choices reject invalid registration, duration and abilities', ({
    assert,
  }) => {
    const choices = buildDefaultSetupChoices()
    choices.policy.registration = 'typo' as never
    assert.throws(() => requireSetupChoices(choices), /policy.registration/)
    choices.policy.registration = 'open'
    choices.authentication = {
      strategy: 'access_tokens',
      guard: 'api',
      token: { revocation: true, lifetime: 'nonsense', abilities: ['*'] },
      applicationRouteRevocation: true,
    }
    assert.throws(() => requireSetupChoices(choices), /authentication.token.lifetime/)
    choices.authentication.token!.lifetime = '7d'
    choices.authentication.token!.abilities = ['']
    assert.throws(() => requireSetupChoices(choices), /authentication.token.abilities/)
  })

  test('rejects an invalid mode and an unsupported version', ({ assert }) => {
    const choices = buildDefaultSetupChoices()
    assert.throws(
      () => requireSetupChoices({ ...choices, mode: 'typo' }),
      'mode: choose services or managed'
    )
    assert.throws(() => requireSetupChoices({ ...choices, version: 2 }), 'version: expected 1')
  })

  test('rejects an unknown authentication strategy and non-boolean password rules', ({
    assert,
  }) => {
    const choices = buildDefaultSetupChoices()
    choices.authentication = {
      strategy: 'jwt' as never,
      guard: 'web',
      applicationRouteRevocation: true,
    }
    assert.throws(
      () => requireSetupChoices(choices),
      'authentication.strategy: choose session or access_tokens'
    )
    for (const key of ['letters', 'mixedCase', 'numbers', 'symbols'] as const) {
      const policy = buildDefaultSetupChoices()
      policy.policy.password[key] = 'yes' as never
      assert.throws(() => requireSetupChoices(policy), `policy.password.${key}: expected a boolean`)
    }
  })
})
