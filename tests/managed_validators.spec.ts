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
import { InvalidInputError } from '../src/errors.js'
import { managedErrorResponse } from '../src/http/responses.js'
import { compileEmbedded, documentFor, requestSchema } from './helpers/openapi.js'

test.group('managed request validation', () => {
  test('default field validators preserve configured registration data for service mapping', async ({
    assert,
  }) => {
    const registrationData = { fullName: 'New User' }
    for (const [validator, input] of [
      [
        signupValidator,
        { email: 'a@example.test', password: 'password123', passwordConfirmation: 'password123' },
      ],
      [invitationAcceptValidator, { password: 'password123', passwordConfirmation: 'password123' }],
      [profileUpdateValidator, { currentPassword: 'password123' }],
    ] as const) {
      const omitted = await validator.validate(input)
      assert.isFalse(Object.hasOwn(omitted, 'registrationData'))
      const output = await validator.validate({ ...input, registrationData })
      assert.deepEqual(output.registrationData, registrationData)
      try {
        await validator.validate({ ...input, registrationData: ['bad'] })
        assert.fail('expected object validation failure')
      } catch (error) {
        assert.equal((error as { status?: number }).status, 422)
      }
    }
  })
  test('invitation role is bounded at the HTTP boundary', async ({ assert }) => {
    try {
      await invitationSendValidator.validate({ email: 'a@example.test', role: 'x'.repeat(65) })
      assert.fail('expected validation failure')
    } catch (error) {
      assert.equal((error as { status?: number }).status, 422)
    }
  })

  test('invitation list limit must be an integer', async ({ assert }) => {
    try {
      await invitationListValidator.validate({ limit: 1.5 })
      assert.fail('expected validation failure')
    } catch (error) {
      assert.equal((error as { status?: number }).status, 422)
    }
  })

  test('password-policy rejection is never misreported as invalid proof', ({ assert }) => {
    const response = managedErrorResponse(new InvalidInputError('Invalid password'), {
      proof: 'password',
    })
    assert.equal(response?.body.errors[0].code, 'E_ACCOUNT_KIT_INVALID_INPUT')
  })
})

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
    [
      'account.invitation.send',
      invitationSendValidator,
      { email: 'a@example.test', role: 'r'.repeat(65) },
    ],
    ['account.invitation.send', invitationSendValidator, { email: 'a@example.test' }],
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

  test('the invitation list query matches the validator', async ({ assert }) => {
    const parameters = (session.paths['/api/v1/account/invitations'].get as any).parameters
    const limit = compileEmbedded(session, parameters[0].schema)
    for (const value of [1, 100, 0, 101, 1.5]) {
      const vine = await invitationListValidator.validate({ limit: value }).then(
        () => true,
        () => false
      )
      assert.equal(limit(value), vine, String(value))
    }
  })
})
