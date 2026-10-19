import { test } from '@japa/runner'
import { type AccountKit } from '../src/account_kit.js'
import { DeliveryError, InvalidSessionError } from '../src/errors.js'
import { registerManagedRoutes } from '../src/http/managed.js'
import type { ManagedQuery, ManagedSuccessBody } from '../src/http/contracts.js'
import { fakeManagedHttp, stubGuard } from './helpers/managed_http_fakes.js'

test.group('managed HTTP dispatch', () => {
  test('a committed social GET callback returns accepted when notification delivery fails', async ({
    assert,
  }) => {
    const { router, routes, context } = fakeManagedHttp()
    const kit = {
      managedHttp: { assertGuard: () => {}, consume: async () => {} },
      socialAuthentication: {
        callback: async () => {
          throw new DeliveryError('Notification failed after commit')
        },
      },
    } as unknown as AccountKit
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: stubGuard({
        strategy: 'access_tokens',
        current: async () => ({ userId: 7, tokenId: 11 }),
        publicCredential: () => 'opaque',
      }),
      enabled: ['socialAuthentication'],
      extensions: { social: { providers: ['google'] } },
    })
    const ctx = context({ provider: 'google' })
    Object.assign(ctx.request, {
      input: (key: string) =>
        ({ state: 'valid-state', code: 'provider-code' })[key as 'state' | 'code'],
    })
    const output = await routes.get('GET /api/v1/auth/oauth/:provider/callback')!(ctx)
    assert.deepEqual(output, { status: 202, body: { committed: true } })
  })

  test('a committed social unlink returns typed accepted when notification delivery fails', async ({
    assert,
  }) => {
    const { router, routes, context } = fakeManagedHttp()
    const account = {
      id: 7,
      email: 'a@example.test',
      unverifiedEmail: null,
      hasPassword: true,
      active: true,
    }
    const kit = {
      managedHttp: { assertGuard: () => {}, consume: async () => {} },
      authentication: { current: async () => account },
      socialAuthentication: {
        unlink: async () => {
          throw new DeliveryError('Notification failed after unlink commit')
        },
      },
    } as unknown as AccountKit
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: stubGuard({
        strategy: 'access_tokens',
        current: async () => ({ userId: 7, tokenId: 11 }),
        publicCredential: () => 'opaque',
      }),
      enabled: ['socialAuthentication'],
      extensions: { social: { providers: ['google'] } },
    })
    const ctx = context({ id: '1' })
    Object.assign(ctx.request, { validateUsing: async () => ({ proof: 'valid-proof' }) })
    const output = await routes.get('DELETE /api/v1/account/social-identities/:id')!(ctx)
    const body: ManagedSuccessBody<'account.socialIdentities.unlink'> = { committed: true }
    assert.deepEqual(output, { status: 202, body })
  })

  test('account writes return only their documented response bodies', async ({ assert }) => {
    const { router, routes, context } = fakeManagedHttp()
    const account = {
      id: 7,
      email: 'a@example.test',
      unverifiedEmail: null,
      hasPassword: true,
      active: true,
    }
    const user = { ...account, emailVerifiedAt: null, passwordHash: 'never expose' }
    const kit = {
      managedHttp: { assertGuard: () => {}, consume: async () => {}, passwordAllowed: () => true },
      authentication: {
        current: async () => account,
        requireActive: async () => account,
        logout: async () => {},
      },
      emailPasswordManagement: {
        updateProfile: async () => user,
        changePassword: async () => {},
      },
      emailVerification: { send: async () => 'sent' },
      invitations: {
        send: async () => ({ id: 2 }),
        list: async () => ({ items: [], nextCursor: null }),
        resend: async () => ({ id: 2 }),
        revoke: async () => {},
      },
    } as unknown as AccountKit
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: stubGuard({
        strategy: 'access_tokens',
        publicCredential: () => 'opaque',
        current: async () => ({ userId: 7, tokenId: 11 }),
        logoutCredential: async () => ({ userId: 7, identifier: 11 }),
      }),
      enabled: ['authentication', 'emailPasswordManagement', 'emailVerification', 'invitations'],
    })
    const expected: Array<[string, number, unknown]> = [
      ['POST /api/v1/account/logout', 204, undefined],
      ['PATCH /api/v1/account/profile', 200, { account }],
      ['POST /api/v1/account/password', 200, { changed: true }],
      ['POST /api/v1/account/email-verification/send', 200, { result: 'sent' }],
      ['POST /api/v1/account/invitations', 201, { id: 2 }],
      ['GET /api/v1/account/invitations', 200, { items: [], nextCursor: null }],
      ['POST /api/v1/account/invitations/:id/resend', 200, { id: 2 }],
      ['DELETE /api/v1/account/invitations/:id', 204, undefined],
    ]
    for (const [route, status, body] of expected) {
      const output = await routes.get(route)!(context({ id: '2' }))
      assert.equal((output as { status: number }).status, status)
      assert.deepEqual((output as { body?: unknown }).body, body)
    }
  })

  test('representation failures preserve committed invitation, email, and profile responses', async ({
    assert,
  }) => {
    const { router, routes, context } = fakeManagedHttp()
    const user = {
      id: 7,
      email: 'a@example.test',
      unverifiedEmail: null,
      hasPassword: true,
      emailVerifiedAt: null,
      passwordHash: 'private',
    }
    const account = {
      id: 7,
      email: user.email,
      unverifiedEmail: null,
      hasPassword: true,
      active: true,
    }
    const kit = {
      managedHttp: { assertGuard: () => {}, consume: async () => {}, passwordAllowed: () => true },
      authentication: { current: async () => account },
      invitations: { accept: async () => user },
      emailPasswordManagement: {
        completeEmailChange: async () => user,
        updateProfile: async () => user,
      },
    } as unknown as AccountKit
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: stubGuard({
        strategy: 'access_tokens',
        current: async () => ({ userId: 7, tokenId: 11 }),
      }),
      enabled: ['invitations', 'emailPasswordManagement'],
      extensions: {
        representAccount: async () => {
          throw new Error('private rendering failure')
        },
      },
    })
    for (const [path, status] of [
      ['POST /api/v1/auth/invitations/:token', 201],
      ['POST /api/v1/auth/email-change/:token', 200],
      ['PATCH /api/v1/account/profile', 200],
    ] as const) {
      const diagnostics: unknown[] = []
      const ctx = context({ token: 'secret-proof' })
      Object.assign(ctx, {
        logger: { warn: (data: unknown) => diagnostics.push(data) },
      })
      const output = await routes.get(path)!(ctx)
      assert.deepEqual(output, { status, body: { account } })
      assert.deepEqual(diagnostics, [
        {
          operation: path.includes('invitations')
            ? 'auth.invitation.accept'
            : path.includes('email-change')
              ? 'auth.emailChange.complete'
              : 'account.profile.update',
          outcome: 'representation_failed',
        },
      ])
    }
  })

  test('post-commit notification failure remains a successful write response', async ({
    assert,
  }) => {
    const { router, routes, context } = fakeManagedHttp()
    const kit = {
      managedHttp: { assertGuard: () => {} },
      authentication: {
        current: async () => ({
          id: 1,
          email: 'a@example.test',
          unverifiedEmail: 'a@example.test',
          hasPassword: true,
          active: false,
        }),
      },
      emailVerification: {
        send: async () => {
          throw new DeliveryError('private mail failure')
        },
      },
    } as unknown as AccountKit
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: stubGuard({
        strategy: 'access_tokens',
        current: async () => ({ userId: 1, tokenId: 2 }),
      }),
      enabled: ['emailVerification'],
    })
    const ctx = context()
    const diagnostics: unknown[] = []
    Object.assign(ctx, { logger: { warn: (data: unknown) => diagnostics.push(data) } })
    const output = await routes.get('POST /api/v1/account/email-verification/send')!(ctx)
    const committed: ManagedSuccessBody<'account.emailVerification.send'> = { committed: true }
    assert.deepEqual(output, { status: 202, body: committed })
    assert.deepEqual(diagnostics, [
      { operation: 'account.emailVerification.send', outcome: 'delivery_failed' },
    ])
  })

  test('password-reset delivery failure retains its public acknowledgement and sanitized diagnostic', async ({
    assert,
  }) => {
    const { router, routes, context } = fakeManagedHttp()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () =>
        ({
          managedHttp: { assertGuard: () => {} },
          passwordReset: {
            request: async () => {
              throw new DeliveryError('private delivery detail')
            },
          },
        }) as unknown as AccountKit,
      guard: stubGuard({
        strategy: 'access_tokens',
        current: async () => ({ userId: 1, tokenId: 2 }),
      }),
      enabled: ['passwordReset'],
    })
    const diagnostics: unknown[] = []
    const ctx = context()
    Object.assign(ctx, { logger: { warn: (data: unknown) => diagnostics.push(data) } })
    assert.deepEqual(await routes.get('POST /api/v1/auth/password-reset')!(ctx), {
      status: 202,
      body: { message: 'If the account exists, instructions will be sent.' },
    })
    assert.deepEqual(diagnostics, [
      { operation: 'auth.passwordReset.request', outcome: 'delivery_failed' },
    ])
  })

  test('invitation query contract is separate from its empty request body', ({ assert }) => {
    const query: ManagedQuery<'account.invitation.list'> = { limit: 25, cursor: 'opaque' }
    assert.deepEqual(query, { limit: 25, cursor: 'opaque' })
  })

  test('social GET callback query contract represents success and provider denial', ({
    assert,
  }) => {
    const success: ManagedQuery<'auth.oauth.callback'> = {
      code: 'provider-code',
      state: 'bound-state',
    }
    const denial: ManagedQuery<'auth.oauth.callback'> = {
      error: 'access_denied',
      state: 'bound-state',
    }
    assert.deepEqual(success, { code: 'provider-code', state: 'bound-state' })
    assert.deepEqual(denial, { error: 'access_denied', state: 'bound-state' })
  })

  test('negotiated errors preserve an existing Vary value', async ({ assert }) => {
    const { router, routes, context } = fakeManagedHttp()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => ({ managedHttp: { assertGuard: () => {} } }) as unknown as AccountKit,
      guard: stubGuard({
        strategy: 'access_tokens',
        current: async () => {
          throw new InvalidSessionError()
        },
      }),
      enabled: ['invitations'],
    })
    const ctx = context()
    ctx.response.header('Vary', 'Origin')
    const output = await routes.get('GET /api/v1/account/invitations')!(ctx)
    assert.equal((output as { status: number }).status, 401)
    assert.equal(ctx.headers.Vary, 'Origin, Accept')
  })
})
