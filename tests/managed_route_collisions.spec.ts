import { test } from '@japa/runner'
import { assertManagedRouteCollisions, planManagedRoutes } from '../src/http/routes.js'
import { bootTestApp } from './helpers/app.js'

test.group('managed route plan', () => {
  test('rejects a colliding application route before registering any managed route', ({
    assert,
  }) => {
    assert.throws(
      () =>
        planManagedRoutes({ prefix: '/api/v1', strategy: 'session', enabled: ['authentication'] }, [
          { method: 'POST', path: '/api/v1/auth/login', name: 'application.login' },
        ]),
      /POST \/api\/v1\/auth\/login.*application\.login/
    )
  })

  test('detects static paths intersecting managed parameters before and after commit', ({
    assert,
  }) => {
    const selection = {
      prefix: '/api/v1',
      strategy: 'session' as const,
      enabled: ['passwordReset'] as const,
    }
    const existing = [
      { method: 'GET', path: '/api/v1/auth/password-reset/specific', name: 'application.specific' },
    ]
    assert.throws(() => planManagedRoutes(selection, existing), /application\.specific/)
    const managed = planManagedRoutes(selection)
    assert.throws(() => assertManagedRouteCollisions(managed, existing), /application\.specific/)
    assert.doesNotThrow(() =>
      assertManagedRouteCollisions(managed, [
        { method: 'GET', path: '/api/v1/auth/password-reset/specific/extra' },
      ])
    )
  })

  test('rejects optional and wildcard application patterns during planning and commit', ({
    assert,
  }) => {
    const selection = {
      prefix: '/api/v1',
      strategy: 'session' as const,
      enabled: ['authentication'] as const,
    }
    const managed = planManagedRoutes(selection)
    for (const [path, name] of [
      ['/api/v1/auth/:action?', 'application.optional'],
      ['/api/v1/auth/*', 'application.wildcard'],
      ['/api/v1/auth/login/:tail?', 'application.emptyOptionalTail'],
      ['/api/v1/auth/:action-name', 'application.hyphenParameter'],
    ] as const) {
      const existing = [{ method: 'POST', path, name }]
      assert.throws(
        () => planManagedRoutes(selection, existing),
        new RegExp(name.replace('.', '\\.'))
      )
      assert.throws(
        () => assertManagedRouteCollisions(managed, existing),
        new RegExp(name.replace('.', '\\.'))
      )
    }
    assert.doesNotThrow(() =>
      planManagedRoutes(selection, [
        { method: 'POST', path: '/api/v1/unrelated/*' },
        { method: 'POST', path: '/api/v1/other/:action?' },
        { method: 'POST', path: '/api/v1/auth/login/*' },
        { method: 'POST', path: '/api/v1/:extra?/auth/login' },
        { method: 'POST', path: '/api/v1/auth/:action.json' },
      ])
    )
    assert.doesNotThrow(() =>
      assertManagedRouteCollisions(managed, [
        { method: 'POST', path: '/api/v1/auth/login/*' },
        { method: 'POST', path: '/api/v1/:extra?/auth/login' },
        { method: 'POST', path: '/api/v1/auth/:action.json' },
      ])
    )
  })

  test('collision decisions follow the installed Adonis tree router', async ({ assert }) => {
    const app = await bootTestApp()
    try {
      const router = await app.app.container.make('router')
      const patterns = [
        ['/api/v1/auth/:action?', true],
        ['/api/v1/auth/*', true],
        ['/api/v1/auth/login/:tail?', true],
        ['/api/v1/auth/:action-name', true],
        ['/api/v1/auth/login/*', false],
        ['/api/v1/:extra?/auth/login', false],
        ['/api/v1/auth/:action.json', false],
        ['/api/v1/auth/:middle?/login', false],
        ['/api/v1/auth/login/:first?/:second?', true],
      ] as const
      for (const [index, [pattern]] of patterns.entries()) {
        router.route(`/case${index}${pattern}`, ['POST'], () => null)
      }
      const proofPatterns = [
        ['/api/v1/auth/password-reset/specific', '/api/v1/auth/password-reset/specific', true],
        ['/api/v1/auth/password-reset/*', '/api/v1/auth/password-reset/specific', true],
        ['/api/v1/auth/password-reset/:token-name', '/api/v1/auth/password-reset/specific', true],
        [
          '/api/v1/auth/password-reset/:token.json',
          '/api/v1/auth/password-reset/specific.json',
          true,
        ],
        ['/api/v1/auth/password-reset/specific/*', '/api/v1/auth/password-reset/specific', false],
      ] as const
      for (const [index, [pattern]] of proofPatterns.entries()) {
        router.route(`/proof${index}${pattern}`, ['POST'], () => null)
      }
      router.commit()

      const selection = {
        prefix: '/api/v1',
        strategy: 'session' as const,
        enabled: ['authentication'] as const,
      }
      const managed = planManagedRoutes(selection)
      for (const [index, [pattern, intersects]] of patterns.entries()) {
        const observed = Boolean(router.match(`/case${index}/api/v1/auth/login`, 'POST', false))
        assert.equal(observed, intersects, pattern)
        const existing = [{ method: 'POST', path: pattern }]
        if (intersects) {
          assert.throws(() => planManagedRoutes(selection, existing), /Managed route collision/)
          assert.throws(
            () => assertManagedRouteCollisions(managed, existing),
            /Managed route collision/
          )
        } else {
          assert.doesNotThrow(() => planManagedRoutes(selection, existing))
          assert.doesNotThrow(() => assertManagedRouteCollisions(managed, existing))
        }
      }
      assert.isTrue(Boolean(router.match('/case5/api/v1/x/auth/login', 'POST', false)))

      const proofSelection = {
        prefix: '/api/v1',
        strategy: 'session' as const,
        enabled: ['passwordReset'] as const,
      }
      const managedProof = planManagedRoutes(proofSelection)
      for (const [index, [pattern, concrete, intersects]] of proofPatterns.entries()) {
        assert.equal(Boolean(router.match(`/proof${index}${concrete}`, 'POST', false)), intersects)
        const existing = [{ method: 'POST', path: pattern }]
        if (intersects) {
          assert.throws(
            () => planManagedRoutes(proofSelection, existing),
            /Managed route collision/
          )
          assert.throws(
            () => assertManagedRouteCollisions(managedProof, existing),
            /Managed route collision/
          )
        } else {
          assert.doesNotThrow(() => planManagedRoutes(proofSelection, existing))
          assert.doesNotThrow(() => assertManagedRouteCollisions(managedProof, existing))
        }
      }
    } finally {
      await app.close()
    }
  })

  test('honors Adonis parameter constraints and suffixes in both collision checks', async ({
    assert,
  }) => {
    const app = await bootTestApp()
    try {
      const router = await app.app.container.make('router')
      const cases = [
        { pattern: '/auth/:id', matcher: /^[0-9]+$/, intersects: false },
        { pattern: '/auth/:id', matcher: /^login$/, intersects: true },
        { pattern: '/auth/:action-name', matcher: /^\d+$/, intersects: false },
        { pattern: '/auth/:action-name', matcher: /^login$/, intersects: true },
        { pattern: '/auth/login/:tail.json?', intersects: false },
        { pattern: '/auth/login/:tail?', intersects: true },
      ] as const
      for (const [index, item] of cases.entries()) {
        const route = router.route(`/case${index}/api/v1${item.pattern}`, ['POST'], () => null)
        if ('matcher' in item)
          route.where(item.pattern.includes('action-name') ? 'action-name' : 'id', item.matcher)
      }
      router
        .group(() => {
          router.route('/auth/:id', ['POST'], () => null)
        })
        .prefix('/group0/api/v1')
        .where('id', /^[0-9]+$/)
      router
        .group(() => {
          router.route('/auth/:id', ['POST'], () => null)
        })
        .prefix('/group1/api/v1')
        .where('id', /^login$/)
      router.commit()

      const all = router.toJSON().root ?? []
      for (const [index, item] of cases.entries()) {
        const prefix = `/case${index}/api/v1`
        const path = `${prefix}${item.pattern}`
        const stored = all.find((route) => route.pattern === path)
        assert.isDefined(stored, path)
        const existing = [
          { method: 'POST', path, tokens: stored!.tokens, matchers: stored!.matchers },
        ]
        const selection = {
          prefix,
          strategy: 'session' as const,
          enabled: ['authentication'] as const,
        }
        const managed = planManagedRoutes(selection)
        assert.equal(
          Boolean(router.match(`${prefix}/auth/login`, 'POST', false)),
          item.intersects,
          path
        )
        if (item.intersects) {
          assert.throws(() => planManagedRoutes(selection, existing), /Managed route collision/)
          assert.throws(
            () => assertManagedRouteCollisions(managed, existing),
            /Managed route collision/
          )
        } else {
          assert.doesNotThrow(() => planManagedRoutes(selection, existing))
          assert.doesNotThrow(() => assertManagedRouteCollisions(managed, existing))
        }
      }
      for (const [index, intersects] of [false, true].entries()) {
        const prefix = `/group${index}/api/v1`
        const path = `${prefix}/auth/:id`
        const stored = all.find((route) => route.pattern === path)
        assert.isDefined(stored, path)
        const existing = [
          { method: 'POST', path, tokens: stored!.tokens, matchers: stored!.matchers },
        ]
        const selection = {
          prefix,
          strategy: 'session' as const,
          enabled: ['authentication'] as const,
        }
        const managed = planManagedRoutes(selection)
        assert.equal(Boolean(router.match(`${prefix}/auth/login`, 'POST', false)), intersects, path)
        if (intersects) {
          assert.throws(() => planManagedRoutes(selection, existing), /Managed route collision/)
          assert.throws(
            () => assertManagedRouteCollisions(managed, existing),
            /Managed route collision/
          )
        } else {
          assert.doesNotThrow(() => planManagedRoutes(selection, existing))
          assert.doesNotThrow(() => assertManagedRouteCollisions(managed, existing))
        }
      }
    } finally {
      await app.close()
    }
  })

  test('collision planning agrees with Adonis over parameter-tail permutations', async ({
    assert,
  }) => {
    const app = await bootTestApp()
    try {
      const router = await app.app.container.make('router')
      const bases = [
        '/auth/login',
        '/auth/:action',
        '/auth/:action?',
        '/auth/:action.json',
        '/auth/:action-name',
      ]
      const tails = [
        '',
        '/:id',
        '/:tail?',
        '/:tail.json?',
        '/:id/:tail?',
        '/:id/:tail.json?',
        '/:id.json/:tail?',
        '/:id/:other/:tail?',
        '/:tail?/:id',
        '/:tail?/:id/:other?',
        '/static',
        '/static/:tail?',
        '/*',
      ]
      const patterns = bases.flatMap((base) => tails.map((tail) => `${base}${tail}`))
      patterns.push('/auth/*')
      for (const [index, pattern] of patterns.entries()) {
        router.route(`/corpus${index}/api/v1${pattern}`, ['POST'], () => null)
      }
      router.commit()
      const stored = router.toJSON().root ?? []
      for (const [index, pattern] of patterns.entries()) {
        const prefix = `/corpus${index}/api/v1`
        const path = `${prefix}${pattern}`
        const route = stored.find((candidate) => candidate.pattern === path)
        assert.isDefined(route, path)
        const existing = [
          { method: 'POST', path, tokens: route!.tokens, matchers: route!.matchers },
        ]
        const unparsed = [{ method: 'POST', path }]
        const selection = {
          prefix,
          strategy: 'session' as const,
          enabled: ['authentication'] as const,
        }
        const managed = planManagedRoutes(selection)
        const intersects = Boolean(router.match(`${prefix}/auth/login`, 'POST', false))
        if (intersects) {
          assert.throws(
            () => planManagedRoutes(selection, existing),
            /Managed route collision/,
            path
          )
          assert.throws(
            () => planManagedRoutes(selection, unparsed),
            /Managed route collision/,
            path
          )
          assert.throws(
            () => assertManagedRouteCollisions(managed, existing),
            /Managed route collision/,
            path
          )
          assert.throws(
            () => assertManagedRouteCollisions(managed, unparsed),
            /Managed route collision/,
            path
          )
        } else {
          assert.doesNotThrow(() => planManagedRoutes(selection, existing), path)
          assert.doesNotThrow(() => planManagedRoutes(selection, unparsed), path)
          assert.doesNotThrow(() => assertManagedRouteCollisions(managed, existing), path)
          assert.doesNotThrow(() => assertManagedRouteCollisions(managed, unparsed), path)
        }
      }
    } finally {
      await app.close()
    }
  })
})
