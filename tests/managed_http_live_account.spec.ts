import { test } from '@japa/runner'
import { registerManagedRoutes } from '../src/http/managed.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { fakeManagedHttp, stubGuard } from './helpers/managed_http_fakes.js'
import { dbTime } from './helpers/db_time.js'

test.group('managed HTTP verification policy with live account state', (group) => {
  const app = useTestApp(group)

  test('optional verification permits inactive access but rejects restricted and stale credentials', async ({
    assert,
  }) => {
    const user = await insertUser(app, { verified: false })
    const { account } = makeService(app, {
      authentication: {
        strategy: 'session',
        guard: 'web',
        canAccess: async (candidate, trx) => {
          const row = await trx
            .from('users')
            .select('disabled_at')
            .where('id', candidate.id)
            .first()
          return !row?.disabled_at
        },
      },
    })
    const { router, routes, context } = fakeManagedHttp()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => account,
      guard: stubGuard({
        current: async () => ({ userId: user.id, revision: null }),
      }),
      enabled: ['invitations'],
      verificationRequired: false,
    })
    const run = () => routes.get('GET /api/v1/account/invitations')!(context())
    assert.equal(((await run()) as { status: number }).status, 200)

    await app.db
      .from('users')
      .where('id', user.id)
      .update({ disabled_at: dbTime(app) })
    assert.equal(((await run()) as { status: number }).status, 401)

    await app.db.from('users').where('id', user.id).update({ disabled_at: null })
    await account.authentication.changeRestriction({ userId: user.id, change: async () => {} })
    assert.equal(((await run()) as { status: number }).status, 401)
  })

  test('email-only profile update omits registration data for a required field mapper', async ({
    assert,
  }) => {
    const user = await insertUser(app)
    let mapped = false
    const { account } = makeService(app, {
      authentication: { strategy: 'session', guard: 'web' },
      registration: {
        availability: 'open',
        mapFields: async () => {
          mapped = true
          throw new Error('fullName is required')
        },
      },
    })
    const { router, routes, context } = fakeManagedHttp()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => account,
      guard: stubGuard({
        current: async () => ({ userId: user.id, revision: null }),
      }),
      enabled: ['emailPasswordManagement'],
    })
    const profile = routes.get('PATCH /api/v1/account/profile')!
    const ctx = context()
    Object.assign(ctx.request, {
      csrfToken: 'proof',
      validateUsing: async () => ({ currentPassword: 'password123', email: 'new@example.test' }),
    })
    assert.equal(((await profile(ctx)) as { status: number }).status, 200)
    assert.isFalse(mapped)

    const empty = context()
    Object.assign(empty.request, {
      csrfToken: 'proof',
      validateUsing: async () => ({ currentPassword: 'password123' }),
    })
    assert.equal(((await profile(empty)) as { status: number }).status, 422)
    assert.isFalse(mapped)
  })

  test('wrong current password has an identity-proof error on profile and password writes', async ({
    assert,
  }) => {
    const user = await insertUser(app)
    const { account } = makeService(app, {
      authentication: { strategy: 'session', guard: 'web' },
    })
    const { router, routes, context } = fakeManagedHttp()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => account,
      guard: stubGuard({
        current: async () => ({ userId: user.id, revision: null }),
      }),
      enabled: ['emailPasswordManagement'],
    })
    for (const [path, input] of [
      ['PATCH /api/v1/account/profile', { currentPassword: 'wrong', email: 'new@example.test' }],
      [
        'POST /api/v1/account/password',
        { currentPassword: 'wrong', newPassword: 'new-password123' },
      ],
    ] as const) {
      const ctx = context()
      Object.assign(ctx.request, { csrfToken: 'proof', validateUsing: async () => input })
      const output = await routes.get(path)!(ctx)
      assert.equal((output as { status: number }).status, 403)
      assert.deepEqual((output as { body: unknown }).body, {
        errors: [
          {
            code: 'E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED',
            message: 'Current identity proof could not be confirmed.',
          },
        ],
      })
    }
  })
})
