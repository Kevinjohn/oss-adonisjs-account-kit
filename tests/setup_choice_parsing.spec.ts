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
})
