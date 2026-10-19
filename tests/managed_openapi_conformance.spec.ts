import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import type { AccountKit } from '../src/account_kit.js'
import {
  AuthorizationError,
  DeliveryError,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidInputError,
  InvalidTokenError,
  InvitationNotFoundError,
  SocialTransactionError,
  ThrottledError,
  UnverifiedEmailError,
} from '../src/errors.js'
import { registerManagedRoutes, type ManagedRoutesOptions } from '../src/http/managed.js'
import { generateManagedOpenApi } from '../src/http/openapi.js'
import { managedErrorResponse } from '../src/http/responses.js'
import { managedRouteRegistration } from '../src/http/route_registration.js'
import { signupValidator } from '../src/http/validators.js'
import type { CurrentAccount } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService, tokenFrom } from './helpers/fakes.js'
import { fakeManagedHttp } from './helpers/managed_http_fakes.js'
import { allCapabilities, conformance } from './helpers/openapi.js'

type Strategy = 'session' | 'access_tokens'
type Handler = (context: HttpContext) => Promise<unknown>

function mount(
  strategy: Strategy,
  kit: AccountKit,
  account: CurrentAccount | undefined,
  options: Partial<ManagedRoutesOptions<unknown>> = {}
) {
  const { router, routes, context } = fakeManagedHttp()
  const guardName = strategy === 'session' ? 'web' : 'api'
  registerManagedRoutes(router, {
    prefix: '/api/v1',
    kit: async () => kit,
    guard: {
      strategy,
      name: guardName,
      forRequest: () => ({
        strategy,
        name: guardName,
        establish: async () => (strategy === 'session' ? null : 'token-credential'),
        terminate: async () => {},
      }),
      current: async () => ({ userId: account?.id ?? 0, tokenId: 1 }),
      publicCredential: () => 'opaque-token',
    },
    enabled: allCapabilities,
    extensions: { social: { providers: ['google'] }, ...options.extensions },
    ...options,
  })
  const document = generateManagedOpenApi({
    registration: managedRouteRegistration(router)!,
    info: { title: 'Conformance', version: '1.0.0' },
  })
  /** Run a route with a JSON body, path params and an optional `Accept` header. */
  async function call(
    key: string,
    input: { body?: Record<string, unknown>; params?: Record<string, string>; accept?: string } = {}
  ) {
    const ctx = context(input.params)
    const body = input.body ?? {}
    Object.assign(ctx.request, {
      csrfToken: 'csrf-token',
      header: (name: string) => (name.toLowerCase() === 'accept' ? input.accept : undefined),
      input: (name: string) => body[name],
      validateUsing: (validator: { validate(data: unknown): Promise<unknown> }) =>
        validator.validate(body),
    })
    return (routes.get(key) as Handler)(ctx)
  }
  return { call, document }
}

test.group('managed responses conform to the OpenAPI document', (group) => {
  const app = useTestApp(group)

  async function realKit(strategy: Strategy = 'access_tokens') {
    const user = await insertUser(app, { email: 'actor@example.test' })
    const service = makeService(app, {
      authentication: { guard: strategy === 'session' ? 'web' : 'api', strategy },
      registration: { availability: 'open' },
      enabled: [
        'passwordReset',
        'emailVerification',
        'invitations',
        'emailPasswordManagement',
        'registration',
      ],
    })
    const account: CurrentAccount = {
      id: user.id,
      email: user.email,
      unverifiedEmail: null,
      hasPassword: true,
      active: true,
    }
    const kit = {
      ...service.account,
      managedHttp: { ...service.account.managedHttp, consume: async () => {} },
      authentication: {
        ...service.account.authentication,
        current: async () => account,
        requireActive: async () => account,
      },
    } as unknown as AccountKit
    return { kit, account, recorder: service.recorder }
  }

  for (const strategy of ['session', 'access_tokens'] as const) {
    test(`${strategy}: sign-in, signup, profile and logout bodies conform`, async ({ assert }) => {
      const { kit, account } = await realKit(strategy)
      const { call, document } = mount(strategy, kit, account)
      const credentials = { email: 'actor@example.test', password: 'password123' }
      const outputs: Array<[string, unknown]> = [
        ['auth.login', await call('POST /api/v1/auth/login', { body: credentials })],
        [
          'auth.signup',
          await call('POST /api/v1/auth/signup', {
            body: {
              email: 'new@example.test',
              password: 'password123',
              passwordConfirmation: 'password123',
            },
          }),
        ],
        [
          'auth.signup',
          await call('POST /api/v1/auth/signup', {
            body: {
              email: 'actor@example.test',
              password: 'password123',
              passwordConfirmation: 'password123',
            },
          }),
        ],
        ['account.profile.show', await call('GET /api/v1/account/profile')],
        ['account.logout', await call('POST /api/v1/account/logout')],
      ]
      if (strategy === 'session') outputs.push(['auth.csrf', await call('GET /api/v1/auth/csrf')])
      assert.deepEqual(
        outputs.map(([, output]) => (output as { status: number }).status),
        strategy === 'session' ? [200, 201, 422, 200, 204, 200] : [200, 201, 422, 200, 204]
      )
      if (strategy === 'access_tokens')
        assert.equal((outputs[0][1] as { body: { token: string } }).body.token, 'opaque-token')
      for (const [operation, output] of outputs)
        assert.deepEqual(conformance(document, operation, output), [], operation)
    })
  }

  test('password reset, verification, password change and invitation bodies conform', async ({
    assert,
  }) => {
    const { kit, account, recorder } = await realKit()
    const { call, document } = mount('access_tokens', kit, account)
    const check = (operation: string, output: unknown) =>
      assert.deepEqual(conformance(document, operation, output), [], operation)

    check(
      'auth.passwordReset.request',
      await call('POST /api/v1/auth/password-reset', { body: { email: 'actor@example.test' } })
    )
    const resetToken = tokenFrom(recorder.calls.at(-1)!.args[1])
    check(
      'auth.passwordReset.inspect',
      await call('GET /api/v1/auth/password-reset/:token', { params: { token: resetToken } })
    )
    for (const accept of [undefined, 'application/vnd.api+json'])
      assert.deepEqual(
        conformance(
          document,
          'auth.passwordReset.inspect',
          await call('GET /api/v1/auth/password-reset/:token', {
            params: { token: 'x'.repeat(43) },
            accept,
          }),
          accept
        ),
        []
      )
    check(
      'auth.passwordReset.complete',
      await call('POST /api/v1/auth/password-reset/:token', {
        params: { token: resetToken },
        body: { password: 'password456', passwordConfirmation: 'password456' },
      })
    )
    check(
      'account.password.change',
      await call('POST /api/v1/account/password', {
        body: {
          currentPassword: 'password456',
          newPassword: 'password789',
          newPasswordConfirmation: 'password789',
        },
      })
    )
    check(
      'account.emailVerification.send',
      await call('POST /api/v1/account/email-verification/send')
    )

    const sent = await call('POST /api/v1/account/invitations', {
      body: { email: 'invitee@example.test', role: 'member' },
    })
    check('account.invitation.send', sent)
    const id = String((sent as { body: { id: number } }).body.id)
    const listed = await call('GET /api/v1/account/invitations')
    assert.lengthOf((listed as { body: { items: unknown[] } }).body.items, 1)
    check('account.invitation.list', listed)
    check(
      'account.invitation.resend',
      await call('POST /api/v1/account/invitations/:id/resend', { params: { id } })
    )
    const invitationToken = tokenFrom(recorder.calls.at(-1)!.args[1])
    check(
      'auth.invitation.inspect',
      await call('GET /api/v1/auth/invitations/:token', { params: { token: invitationToken } })
    )
    check(
      'auth.invitation.accept',
      await call('POST /api/v1/auth/invitations/:token', {
        params: { token: invitationToken },
        body: { password: 'password123', passwordConfirmation: 'password123' },
      })
    )
    const second = await call('POST /api/v1/account/invitations', {
      body: { email: 'other@example.test', role: 'member' },
    })
    check(
      'account.invitation.revoke',
      await call('DELETE /api/v1/account/invitations/:id', {
        params: { id: String((second as { body: { id: number } }).body.id) },
      })
    )
    check(
      'account.invitation.revoke',
      await call('DELETE /api/v1/account/invitations/:id', { params: { id: '999' } })
    )
  })

  test('application representations conform to the application account schema', async ({
    assert,
  }) => {
    const { kit, account } = await realKit()
    const accountSchema = {
      type: 'object',
      properties: { id: { type: ['integer', 'string'] }, displayName: { type: 'string' } },
      required: ['id', 'displayName'],
      additionalProperties: false,
    }
    let fail = false
    const represented = mount('access_tokens', kit, account, {
      extensions: {
        social: { providers: ['google'] },
        representAccount: (value) => {
          if (fail) throw new Error('representation failed')
          return { id: value.id, displayName: value.email }
        },
      },
      openapi: { accountSchema },
    })
    const show = await represented.call('GET /api/v1/account/profile')
    assert.deepEqual(conformance(represented.document, 'account.profile.show', show), [])
    const login = () =>
      represented.call('POST /api/v1/auth/login', {
        body: { email: 'actor@example.test', password: 'password123' },
      })
    assert.deepEqual(conformance(represented.document, 'auth.login', await login()), [])
    fail = true
    const fallback = await login()
    assert.property((fallback as { body: { account: object } }).body.account, 'hasPassword')
    assert.deepEqual(conformance(represented.document, 'auth.login', fallback), [])
    // A default-shaped account does not satisfy the application schema on profile.show.
    assert.isNotEmpty(
      conformance(represented.document, 'account.profile.show', {
        status: 200,
        body: { account },
      })
    )
  })

  test('committed, policy and conflict responses conform', async ({ assert }) => {
    const account: CurrentAccount = {
      id: 7,
      email: 'a@example.test',
      unverifiedEmail: null,
      hasPassword: true,
      active: true,
    }
    let allowed = true
    const kit = {
      managedHttp: {
        assertGuard: () => {},
        assertPublicRegistration: () => {},
        consume: async () => {},
        passwordAllowed: () => allowed,
      },
      authentication: { current: async () => account, requireActive: async () => account },
      emailPasswordManagement: {
        changePassword: async () => {
          throw new DeliveryError('delivery failed')
        },
        updateProfile: async () => {
          throw new EmailAlreadyRegisteredError()
        },
      },
      passwordReset: {
        request: async () => {
          throw new DeliveryError('delivery failed')
        },
      },
    } as unknown as AccountKit
    const { call, document } = mount('access_tokens', kit, account)
    const change = {
      body: {
        currentPassword: 'x',
        newPassword: 'password123',
        newPasswordConfirmation: 'password123',
      },
    }
    const committed = await call('POST /api/v1/account/password', change)
    assert.deepEqual(committed, { status: 202, body: { committed: true } })
    assert.deepEqual(conformance(document, 'account.password.change', committed), [])
    const reset = await call('POST /api/v1/auth/password-reset', {
      body: { email: 'a@example.test' },
    })
    assert.deepEqual(conformance(document, 'auth.passwordReset.request', reset), [])
    allowed = false
    const policy = await call('POST /api/v1/account/password', change)
    assert.equal((policy as { status: number }).status, 422)
    assert.deepEqual(conformance(document, 'account.password.change', policy), [])
    for (const accept of [undefined, 'application/vnd.api+json']) {
      const conflict = await call('PATCH /api/v1/account/profile', {
        body: { email: 'b@example.test', currentPassword: 'x' },
        accept,
      })
      assert.equal((conflict as { status: number }).status, 409)
      assert.deepEqual(conformance(document, 'account.profile.update', conflict, accept), [])
    }
  })

  test('social bodies conform for every flow result', async ({ assert }) => {
    const account: CurrentAccount = {
      id: 'user-1',
      email: 'a@example.test',
      unverifiedEmail: null,
      hasPassword: false,
      active: true,
    }
    const results: unknown[] = [
      { status: 'linked', handoffCode: 'handoff' },
      { status: 'new' },
      { status: 'new', continuation: 'continue' },
      { status: 'new', emailVerificationRequired: true },
      { status: 'link_required' },
      { status: 'reauthenticated', proof: 'proof' },
    ]
    const kit = {
      managedHttp: { assertGuard: () => {}, consume: async () => {} },
      authentication: { current: async () => account },
      socialAuthentication: {
        begin: async () => ({ url: 'https://accounts.example.test/auth', state: 's' }),
        beginConfirmation: async () => ({ url: 'https://accounts.example.test/auth', state: 's' }),
        callback: async () => results.shift(),
        completeRegistration: async () => ({ status: 'new', handoffCode: 'handoff' }),
        redeemHandoff: async () => ({ account, credential: 'c', provider: 'google' }),
        provePassword: async () => 'proof',
        list: async () => [
          { id: 1, provider: 'google', email: null, emailVerified: false, subject: 'hidden' },
        ],
      },
    } as unknown as AccountKit
    const { call, document } = mount('access_tokens', kit, account)
    const check = (operation: string, output: unknown) =>
      assert.deepEqual(conformance(document, operation, output), [], operation)
    const callback = { params: { provider: 'google' }, body: { code: 'c', state: 's' } }
    for (let index = 0; index < 6; index++)
      check(
        'auth.oauth.complete',
        await call('POST /api/v1/auth/oauth/:provider/callback', callback)
      )
    check('auth.methods', await call('GET /api/v1/auth/methods'))
    check(
      'auth.oauth.redirect',
      await call('POST /api/v1/auth/oauth/:provider/redirect', {
        params: { provider: 'google' },
        body: { clientChallenge: 'c'.repeat(43) },
      })
    )
    check(
      'auth.oauth.confirmation',
      await call('POST /api/v1/auth/oauth/:provider/confirmation', {
        params: { provider: 'google' },
        body: { verificationToken: 't', clientChallenge: 'c'.repeat(43) },
      })
    )
    check(
      'auth.oauth.registration',
      await call('POST /api/v1/auth/oauth/registration', { body: { continuation: 'c' } })
    )
    check(
      'auth.oauth.token',
      await call('POST /api/v1/auth/oauth/token', { body: { code: 'c', verifier: 'v'.repeat(43) } })
    )
    check(
      'account.socialProof.password',
      await call('POST /api/v1/account/social-proof/password', {
        body: { password: 'x', purpose: 'social_link' },
      })
    )
    check('account.socialIdentities.list', await call('GET /api/v1/account/social-identities'))
    check('auth.oauth.callback', { status: 200, body: { status: 'linked', account } })
  })

  test('mapped package errors and validation errors conform in both media types', async ({
    assert,
  }) => {
    const { document } = mount('session', {} as AccountKit, undefined)
    const errors: Array<[number, Error]> = [
      [400, new InvalidTokenError()],
      [400, new SocialTransactionError()],
      [401, new InvalidCredentialsError()],
      [403, new UnverifiedEmailError()],
      [403, new AuthorizationError()],
      [404, new InvitationNotFoundError()],
      [409, new EmailAlreadyRegisteredError()],
      [422, new InvalidInputError('bad')],
      [429, new ThrottledError(3)],
    ]
    const operation: Record<number, string> = {
      400: 'auth.oauth.redirect',
      401: 'auth.oauth.redirect',
      403: 'account.invitation.send',
      404: 'account.invitation.revoke',
      409: 'account.invitation.send',
      422: 'account.invitation.send',
      429: 'account.invitation.send',
    }
    for (const [status, error] of errors)
      for (const accept of [undefined, 'application/vnd.api+json']) {
        const mapped = managedErrorResponse(error, { accept, proof: 'password' })!
        assert.equal(mapped.status, status)
        assert.deepEqual(
          conformance(document, operation[status], mapped, mapped.contentType),
          [],
          error.name
        )
      }

    const failure = await signupValidator.validate({ email: 'bad' }).catch((error) => error)
    const messages = failure.messages as Array<{ field: string; rule: string; message: string }>
    assert.deepEqual(
      conformance(document, 'auth.signup', { status: 422, body: { errors: messages } }),
      []
    )
    // The JSON:API rendering of `@adonisjs/http-server` ExceptionHandler.
    const jsonApi = {
      errors: messages.map((message) => ({
        title: message.message,
        code: message.rule,
        source: { pointer: message.field },
      })),
    }
    assert.deepEqual(
      conformance(
        document,
        'auth.signup',
        { status: 422, body: jsonApi },
        'application/vnd.api+json'
      ),
      []
    )
  })
})
