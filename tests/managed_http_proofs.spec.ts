import { test } from '@japa/runner'
import { AccountKit } from '../src/account_kit.js'
import { registerManagedRoutes } from '../src/http/managed.js'
import { fakeManagedHttp, stubGuard } from './helpers/managed_http_fakes.js'

test.group('managed HTTP dispatch', () => {
  test('GET proof inspection stays read-only and sets both protective headers', async ({
    assert,
  }) => {
    const { router, routes, context } = fakeManagedHttp()
    let inspected = 0
    let limited = 0
    const kit = {
      managedHttp: {
        assertGuard: () => {},
        consume: async () => {
          limited++
        },
      },
      passwordReset: {
        inspect: async () => {
          inspected++
          return true
        },
        reset: async () => {
          throw new Error('mutated')
        },
      },
    } as unknown as AccountKit
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: stubGuard({
        strategy: 'access_tokens',
        current: async () => ({ userId: 1, tokenId: 1 }),
      }),
      enabled: ['passwordReset'],
    })
    const ctx = context({ token: 'proof' })
    const output = await routes.get('GET /api/v1/auth/password-reset/:token')!(ctx)
    assert.deepEqual(output, { status: 200, body: { valid: true } })
    assert.equal(inspected, 1)
    assert.equal(limited, 1)
    assert.deepEqual(ctx.headers, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  })

  test('all proof GET and POST routes consume the real managed budget and set protective headers', async ({
    assert,
  }) => {
    const { router, routes, context } = fakeManagedHttp()
    const keys: string[] = []
    const real = new AccountKit({
      config: {
        authentication: { guard: 'api', strategy: 'access_tokens' },
        throttle: { requests: 20, duration: '15m' },
        limiterSecret: 'a'.repeat(32),
        limiterNamespace: 'proof-test',
        passwordPolicy: {
          minLength: 8,
          maxLength: null,
          letters: false,
          mixedCase: false,
          numbers: false,
          symbols: false,
          minScore: 0,
        },
      },
      limiter: {
        use: () => ({
          consume: async (key: string) => {
            keys.push(key)
          },
        }),
      },
    } as never)
    const user = {
      id: 7,
      email: 'a@example.test',
      unverifiedEmail: null,
      hasPassword: true,
      emailVerifiedAt: null,
    }
    const kit = {
      managedHttp: real.managedHttp,
      passwordReset: { inspect: async () => true, reset: async () => {} },
      emailVerification: { inspect: async () => true, complete: async () => 'verified' },
      emailPasswordManagement: {
        inspectEmailChange: async () => true,
        completeEmailChange: async () => user,
      },
      invitations: {
        inspect: async () => ({ email: user.email, role: 'member' }),
        accept: async () => user,
      },
    } as unknown as AccountKit
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: stubGuard({
        strategy: 'access_tokens',
        current: async () => ({ userId: 7, tokenId: 1 }),
      }),
      enabled: ['passwordReset', 'emailVerification', 'emailPasswordManagement', 'invitations'],
    })
    for (const path of [
      '/api/v1/auth/password-reset/:token',
      '/api/v1/auth/email-verification/:token',
      '/api/v1/auth/invitations/:token',
      '/api/v1/auth/email-change/:token',
    ]) {
      for (const method of ['GET', 'POST']) {
        const ctx = context({ token: 'proof' })
        await routes.get(`${method} ${path}`)!(ctx)
        assert.equal(ctx.headers['Cache-Control'], 'no-store')
        assert.equal(ctx.headers['Referrer-Policy'], 'no-referrer')
      }
    }
    assert.equal(keys.length, 8)
    assert.equal(new Set(keys).size, 8)
    assert.isTrue(keys.every((key) => !key.includes('192.0.2.1')))
  })

  test('sensitive account routes forward a purpose-bound proof to shared services', async ({
    assert,
  }) => {
    const { router, routes, context } = fakeManagedHttp()
    const account = {
      id: 7,
      email: 'a@example.test',
      unverifiedEmail: null,
      hasPassword: false,
      active: true,
    }
    const calls: Array<{ operation: string; input: unknown }> = []
    const kit = {
      managedHttp: { assertGuard: () => {}, consume: async () => {}, passwordAllowed: () => true },
      authentication: {
        current: async () => account,
        requireActive: async () => account,
      },
      emailPasswordManagement: {
        changePassword: async (input: unknown) => calls.push({ operation: 'password', input }),
        updateProfile: async (input: unknown) => {
          calls.push({ operation: 'profile', input })
          return account
        },
      },
    } as unknown as AccountKit
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => kit,
      guard: stubGuard({
        strategy: 'access_tokens',
        current: async () => ({ userId: 7, tokenId: 11 }),
      }),
      enabled: ['emailPasswordManagement'],
    })
    const password = context()
    Object.assign(password.request, {
      validateUsing: async () => ({ newPassword: 'new-password', recentProof: 'password-proof' }),
    })
    await routes.get('POST /api/v1/account/password')!(password)
    const profile = context()
    Object.assign(profile.request, {
      validateUsing: async () => ({ email: 'new@example.test', recentProof: 'email-proof' }),
    })
    await routes.get('PATCH /api/v1/account/profile')!(profile)
    assert.deepEqual(calls, [
      {
        operation: 'password',
        input: {
          actorId: 7,
          currentPassword: undefined,
          recentProof: 'password-proof',
          newPassword: 'new-password',
        },
      },
      {
        operation: 'profile',
        input: {
          actorId: 7,
          currentPassword: undefined,
          recentProof: 'email-proof',
          email: 'new@example.test',
        },
      },
    ])
  })
})
