import { test } from '@japa/runner'
import type { Router } from '@adonisjs/core/http'
import { type AccountKit } from '../src/account_kit.ts'
import { registerManagedRoutes } from '../src/http/managed.ts'
import { bootTestApp } from './helpers/app.ts'
import { fakeManagedHttp } from './helpers/managed_http_fakes.ts'

test.group('managed HTTP dispatch', () => {
  test('excludes a named route and rejects a second registration before mutating router', ({
    assert,
  }) => {
    const { router, routes, pending } = fakeManagedHttp()
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
    // `routes` is keyed by method and path, so a repeat would overwrite it; count definitions.
    const count = pending.length
    assert.throws(() => registerManagedRoutes(router, options), /already registered/)
    assert.equal(pending.length, count)
  })

  test('a queued application collision aborts router commit before serving requests', ({
    assert,
  }) => {
    const { router, pending } = fakeManagedHttp()
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
    const { router, pending } = fakeManagedHttp()
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
    const count = pending.length
    assert.throws(() => router.commit(), /late\.login/)
    assert.throws(() => router.commit(), /late\.login/)
    assert.equal(pending.length, count)
  })

  test('collision check preserves router commit receiver, arguments, and result', ({ assert }) => {
    const { router } = fakeManagedHttp()
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

  test('registration keeps AdonisJS route constraints through router commit', async ({
    assert,
  }) => {
    for (const [pattern, matcher, intersects] of [
      ['/auth/:id', /^[0-9]+$/, false],
      ['/auth/:id', /^login$/, true],
      ['/auth/:id', /login/y, true],
      ['/auth/login/:id/:tail?', undefined, true],
      ['/auth/login/:id/:tail.json?', undefined, false],
    ] as const) {
      const app = await bootTestApp()
      try {
        const router = await app.app.container.make('router')
        const route = router.route(`/api/v1${pattern}`, ['POST'], () => null)
        if (matcher) route.where('id', matcher)
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
        if (intersects) assert.throws(() => router.commit(), /Managed route collision/)
        else assert.doesNotThrow(() => router.commit())
      } finally {
        await app.close()
      }
    }
  })

  test('commits managed and application routes with disjoint sticky matchers', async ({
    assert,
  }) => {
    const app = await bootTestApp()
    try {
      const router = await app.app.container.make('router')
      router
        .get('/api/:version/auth/csrf', () => null)
        .where('version', /(?=\d+$)/y)
        .as('app.numeric')
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

      router.commit()
      for (let lookup = 0; lookup < 2; lookup++) {
        assert.equal(router.match('/api/1/auth/csrf', 'GET', false)?.route.name, 'app.numeric')
        assert.equal(
          router.match('/api/v1/auth/csrf', 'GET', false)?.route.name,
          'accountKit.auth.csrf'
        )
      }
    } finally {
      await app.close()
    }
  })
})
