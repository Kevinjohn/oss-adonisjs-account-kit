import { test } from '@japa/runner'
import {
  invitationAcceptValidator,
  invitationListValidator,
  invitationSendValidator,
  loginValidator,
  passwordChangeValidator,
  newPasswordValidator,
  passwordResetRequestValidator,
  profileUpdateValidator,
  signupValidator,
  socialBeginValidator,
  socialCallbackValidator,
  socialConfirmationValidator,
  socialPasswordProofValidator,
  socialRegistrationValidator,
  socialTokenValidator,
  socialUnlinkValidator,
} from '../src/http/validators.js'
import { compileEmbedded, documentFor, requestSchema } from './helpers/openapi.js'

test.group('managed request schemas match the validators', () => {
  const session = documentFor('session')
  const tokens = documentFor('access_tokens')
  const valid = 'password123'
  const verifier = 'v'.repeat(43)
  // Each case is accepted or rejected by both the Vine validator and the documented schema.
  // Cross-field rules (`sameAs`) are described in text, so the cases keep confirmations equal.
  const cases: Array<[string, { validate(input: unknown): Promise<unknown> }, unknown]> = [
    ['auth.login', loginValidator, { email: 'a@example.test', password: 'x' }],
    ['auth.login', loginValidator, { email: 'not-an-email', password: 'x' }],
    ['auth.login', loginValidator, { email: 'a@example.test' }],
    ['auth.login', loginValidator, { email: 'a@example.test', password: 5 }],
    [
      'auth.signup',
      signupValidator,
      { email: 'a@example.test', password: valid, passwordConfirmation: valid },
    ],
    [
      'auth.signup',
      signupValidator,
      { email: 'a@example.test', password: 'short', passwordConfirmation: 'short' },
    ],
    [
      'auth.signup',
      signupValidator,
      {
        email: 'a@example.test',
        password: 'p'.repeat(257),
        passwordConfirmation: 'p'.repeat(257),
      },
    ],
    [
      'auth.signup',
      signupValidator,
      {
        email: `${'a'.repeat(250)}@example.test`,
        password: valid,
        passwordConfirmation: valid,
      },
    ],
    [
      'auth.signup',
      signupValidator,
      {
        email: 'a@example.test',
        password: valid,
        passwordConfirmation: valid,
        registrationData: { name: 'A' },
      },
    ],
    [
      'auth.signup',
      signupValidator,
      {
        email: 'a@example.test',
        password: valid,
        passwordConfirmation: valid,
        registrationData: ['bad'],
      },
    ],
    ['auth.passwordReset.request', passwordResetRequestValidator, { email: 'a@example.test' }],
    ['auth.passwordReset.request', passwordResetRequestValidator, {}],
    [
      'auth.passwordReset.complete',
      newPasswordValidator,
      { password: valid, passwordConfirmation: valid },
    ],
    ['auth.passwordReset.complete', newPasswordValidator, { password: valid }],
    [
      'auth.invitation.accept',
      invitationAcceptValidator,
      { password: valid, passwordConfirmation: valid, registrationData: { a: 1 } },
    ],
    [
      'account.password.change',
      passwordChangeValidator,
      { currentPassword: 'old', newPassword: valid, newPasswordConfirmation: valid },
    ],
    [
      'account.password.change',
      passwordChangeValidator,
      { currentPassword: '', newPassword: valid, newPasswordConfirmation: valid },
    ],
    ['account.profile.update', profileUpdateValidator, {}],
    [
      'account.profile.update',
      profileUpdateValidator,
      { email: 'b@example.test', recentProof: 'p' },
    ],
    ['account.profile.update', profileUpdateValidator, { email: 'nope' }],
    [
      'account.invitation.send',
      invitationSendValidator,
      { email: 'a@example.test', role: 'admin' },
    ],
    ['account.invitation.send', invitationSendValidator, { email: 'a@example.test', role: '' }],
    ['account.invitation.send', invitationSendValidator, { email: 'a@example.test', role: ' ' }],
    [
      'account.invitation.send',
      invitationSendValidator,
      { email: 'a@example.test', role: 'r'.repeat(65) },
    ],
    ['account.invitation.send', invitationSendValidator, { email: 'a@example.test' }],
    [
      'account.invitation.send',
      invitationSendValidator,
      { email: 'a@example.test', role: 'r', scope: 's' },
    ],
    [
      'account.invitation.send',
      invitationSendValidator,
      { email: 'a@example.test', role: 'r'.repeat(64), scope: 's'.repeat(255) },
    ],
    [
      'account.invitation.send',
      invitationSendValidator,
      { email: 'a@example.test', role: 'r', scope: null },
    ],
    [
      'account.invitation.send',
      invitationSendValidator,
      { email: 'a@example.test', role: 'r', scope: '' },
    ],
    [
      'account.invitation.send',
      invitationSendValidator,
      { email: 'a@example.test', role: 'r', scope: 's'.repeat(256) },
    ],
    ['auth.oauth.complete', socialCallbackValidator, { code: 'c', state: 's' }],
    ['auth.oauth.complete', socialCallbackValidator, { code: 'c', state: '' }],
    ['auth.oauth.registration', socialRegistrationValidator, { continuation: 'c' }],
    ['auth.oauth.registration', socialRegistrationValidator, { continuation: '' }],
    [
      'auth.oauth.registration',
      socialRegistrationValidator,
      { continuation: 'c', email: 'bad', registrationData: 1 },
    ],
    ['auth.oauth.confirmation', socialConfirmationValidator, { verificationToken: 't' }],
    ['auth.oauth.confirmation', socialConfirmationValidator, { verificationToken: '' }],
    ['auth.oauth.token', socialTokenValidator, { code: 'c', verifier }],
    ['auth.oauth.token', socialTokenValidator, { code: 'c', verifier: verifier.slice(1) }],
    ['auth.oauth.token', socialTokenValidator, { code: 'c', verifier: 'v'.repeat(128) }],
    ['auth.oauth.token', socialTokenValidator, { code: 'c', verifier: 'v'.repeat(129) }],
    ['auth.oauth.token', socialTokenValidator, { code: '', verifier }],
    [
      'account.socialProof.password',
      socialPasswordProofValidator,
      { password: 'x', purpose: 'social_link' },
    ],
    ['account.socialProof.password', socialPasswordProofValidator, { password: '', purpose: 'x' }],
    ['account.socialIdentities.unlink', socialUnlinkValidator, { proof: 'p' }],
    ['account.socialIdentities.unlink', socialUnlinkValidator, { proof: '' }],
  ]

  for (const [index, [operationId, validator, input]] of cases.entries()) {
    test(`case ${index + 1}: ${operationId} agrees on ${JSON.stringify(input).slice(0, 60)}`, async ({
      assert,
    }) => {
      const document =
        operationId === 'auth.oauth.complete' || operationId === 'auth.oauth.token'
          ? tokens
          : session
      const schema = compileEmbedded(document, requestSchema(document, operationId))
      const vine = await validator.validate(input).then(
        () => true,
        () => false
      )
      assert.equal(schema(input), vine, JSON.stringify(schema.errors))
    })
  }

  test('enumerated values are narrower in the schema than in the validator', async ({ assert }) => {
    // The validators accept any string for these and the handler rejects unknown values with 422.
    const proof = compileEmbedded(session, requestSchema(session, 'account.socialProof.password'))
    assert.isTrue(
      await socialPasswordProofValidator.validate({ password: 'x', purpose: 'x' }).then(() => true)
    )
    assert.isFalse(proof({ password: 'x', purpose: 'x' }))
    const begin = compileEmbedded(session, requestSchema(session, 'auth.oauth.redirect'))
    assert.isTrue(await socialBeginValidator.validate({ intent: 'confirm' }).then(() => true))
    assert.isFalse(begin({ intent: 'confirm' }))
  })

  test('a 129-character verifier is a field error on verifier', async ({ assert }) => {
    const error = await socialTokenValidator
      .validate({ code: 'c', verifier: 'v'.repeat(129) })
      .then(
        () => null,
        (failure) => failure as { messages: Array<{ field: string }> }
      )
    assert.deepEqual(
      error?.messages.map((message) => message.field),
      ['verifier']
    )
  })

  test('invitation role bounds apply after surrounding whitespace is trimmed', async ({
    assert,
  }) => {
    const roleSchema = compileEmbedded(session, requestSchema(session, 'account.invitation.send'))
    const email = 'a@example.test'
    for (const [role, accepted] of [
      [' r ', true],
      [` ${'r'.repeat(64)} `, true],
      [` ${'r'.repeat(65)} `, false],
      [' \t\n ', false],
    ] as const) {
      const input = { email, role }
      assert.equal(roleSchema(input), accepted)
      const [, validated] = await invitationSendValidator.tryValidate(input)
      assert.equal(validated?.role ?? null, accepted ? role.trim() : null)
    }
  })

  test('invitation schemas document the stricter server length for supplementary characters', async ({
    assert,
  }) => {
    const sendSchema = requestSchema(session, 'account.invitation.send')
    const send = compileEmbedded(session, sendSchema)
    const parameters = (session.paths['/api/v1/account/invitations'].get as any).parameters
    const scopeParameter = parameters.find(({ name }: { name: string }) => name === 'scope')
    const listScope = compileEmbedded(session, scopeParameter.schema)
    const email = 'a@example.test'
    const character = '😀'
    const roles = { accepted: character.repeat(32), rejected: character.repeat(33) }
    const scopes = { accepted: `${character.repeat(127)}s`, rejected: character.repeat(128) }
    assert.isTrue(send({ email, role: roles.accepted, scope: scopes.accepted }))
    assert.deepInclude(
      await invitationSendValidator.validate({
        email,
        role: roles.accepted,
        scope: scopes.accepted,
      }),
      { role: roles.accepted, scope: scopes.accepted }
    )
    assert.isTrue(listScope(scopes.accepted))
    assert.deepInclude(await invitationListValidator.validate({ scope: scopes.accepted }), {
      scope: scopes.accepted,
    })

    for (const [field, input] of [
      ['role', { email, role: roles.rejected }],
      ['scope', { email, role: 'r', scope: scopes.rejected }],
    ] as const) {
      assert.isTrue(send(input))
      const [error] = await invitationSendValidator.tryValidate(input)
      assert.deepInclude(error?.messages[0], { field, rule: 'maxLength' })
    }
    assert.isTrue(listScope(scopes.rejected))
    const [error] = await invitationListValidator.tryValidate({ scope: scopes.rejected })
    assert.deepInclude(error?.messages[0], { field: 'scope', rule: 'maxLength' })

    const { properties } = sendSchema as { properties: Record<string, { description: string }> }
    assert.include(properties.role.description, '1–64 UTF-16 code units')
    assert.include(properties.scope.description, '1–255 UTF-16 code units')
    assert.include(scopeParameter.description, '1–255 UTF-16 code units')
  })

  test('the invitation list query matches the validator', async ({ assert }) => {
    const parameters = (session.paths['/api/v1/account/invitations'].get as any).parameters
    const limit = compileEmbedded(session, parameters[0].schema)
    const scope = compileEmbedded(session, parameters[2].schema)
    for (const [value, accepted] of [
      [1, true],
      [100, true],
      [0, false],
      [101, false],
      [1.5, false],
    ] as const) {
      const vine = await invitationListValidator.validate({ limit: value }).then(
        () => true,
        () => false
      )
      assert.equal(limit(value), accepted, String(value))
      assert.equal(vine, accepted, String(value))
    }
    assert.equal(parameters[0].schema.default, 25)
    for (const [value, accepted] of [
      ['s', true],
      ['s'.repeat(255), true],
      ['', false],
      ['s'.repeat(256), false],
    ] as const) {
      const vine = await invitationListValidator.validate({ scope: value }).then(
        () => true,
        () => false
      )
      assert.equal(scope(value), accepted)
      assert.equal(vine, accepted)
    }
  })
})
