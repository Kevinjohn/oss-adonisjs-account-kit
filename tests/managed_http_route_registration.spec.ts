import { test } from '@japa/runner'
import type { Router } from '@adonisjs/core/http'
import { type AccountKit } from '../src/account_kit.js'
import { registerManagedRoutes } from '../src/http/managed.js'
import { fixture } from './helpers/managed_http.js'

test.group('managed HTTP dispatch', () => {
  test('excludes a named route and rejects a second registration before mutating router', ({
    assert,
  }) => {
    const { router, routes } = fixture()
    const options = {
      prefix: '/api/v1',
      kit: async () => ({}) as AccountKit,
      guard: {
        strategy: 'session' as const,
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, revision: null }),
      },
      enabled: ['authentication'] as const,
      except: ['auth.login'] as const,
    }
    registerManagedRoutes(router, options)
    assert.isFalse(routes.has('POST /api/v1/auth/login'))
    const count = routes.size
    assert.throws(() => registerManagedRoutes(router, options), /already registered/)
    assert.equal(routes.size, count)
  })

  test('a queued application collision aborts router commit before serving requests', ({
    assert,
  }) => {
    const { router, pending } = fixture()
    pending.push({ methods: ['POST'], pattern: '/api/v1/auth/login', name: 'application.login' })
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => ({}) as AccountKit,
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, revision: null }),
      },
      enabled: ['authentication'],
    })
    assert.throws(() => router.commit(), /POST \/api\/v1\/auth\/login.*application\.login/)
  })

  test('late application routes are checked and repeated commit stays stable', ({ assert }) => {
    const { router, pending, routes } = fixture()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => ({}) as AccountKit,
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, revision: null }),
      },
      enabled: ['authentication'],
    })
    pending.push({ methods: ['POST'], pattern: '/api/v1/auth/login', name: 'late.login' })
    const count = routes.size
    assert.throws(() => router.commit(), /late\.login/)
    assert.throws(() => router.commit(), /late\.login/)
    assert.equal(routes.size, count)
  })

  test('collision check preserves router commit receiver, arguments, and result', ({ assert }) => {
    const { router } = fixture()
    const original = router.commit
    const sentinel = { committed: true }
    let called = false
    router.commit = function (this: Router, ...args: unknown[]) {
      assert.strictEqual(this, router)
      assert.deepEqual(args, ['test-argument'])
      original.call(this)
      called = true
      return sentinel as never
    } as Router['commit']
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => ({}) as AccountKit,
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => ({}) as never,
        current: async () => ({ userId: 1, revision: null }),
      },
      enabled: ['authentication'],
    })
    assert.strictEqual(
      (router.commit as (...args: unknown[]) => unknown)('test-argument'),
      sentinel
    )
    assert.isTrue(called)
  })
})
