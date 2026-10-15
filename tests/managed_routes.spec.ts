import { test } from '@japa/runner'
import { assertManagedRouteCollisions, planManagedRoutes } from '../src/http/routes.js'

test.group('managed route plan', () => {
  test('publishes the named Phase 1 paths and submission methods', ({ assert }) => {
    const routes = planManagedRoutes({
      prefix: '/api/v1',
      strategy: 'session',
      enabled: [
        'authentication',
        'registration',
        'passwordReset',
        'emailVerification',
        'emailPasswordManagement',
        'invitations',
      ],
    })
    assert.deepEqual(
      routes.map(({ name, method, path }) => [name, method, path]),
      [
        ['auth.signup', 'POST', '/api/v1/auth/signup'],
        ['auth.csrf', 'GET', '/api/v1/auth/csrf'],
        ['auth.login', 'POST', '/api/v1/auth/login'],
        ['auth.passwordReset.request', 'POST', '/api/v1/auth/password-reset'],
        ['auth.passwordReset.inspect', 'GET', '/api/v1/auth/password-reset/:token'],
        ['auth.passwordReset.complete', 'POST', '/api/v1/auth/password-reset/:token'],
        ['auth.emailVerification.inspect', 'GET', '/api/v1/auth/email-verification/:token'],
        ['auth.emailVerification.complete', 'POST', '/api/v1/auth/email-verification/:token'],
        ['auth.invitation.inspect', 'GET', '/api/v1/auth/invitations/:token'],
        ['auth.invitation.accept', 'POST', '/api/v1/auth/invitations/:token'],
        ['auth.emailChange.inspect', 'GET', '/api/v1/auth/email-change/:token'],
        ['auth.emailChange.complete', 'POST', '/api/v1/auth/email-change/:token'],
        ['account.logout', 'POST', '/api/v1/account/logout'],
        ['account.profile.show', 'GET', '/api/v1/account/profile'],
        ['account.profile.update', 'PATCH', '/api/v1/account/profile'],
        ['account.password.change', 'POST', '/api/v1/account/password'],
        ['account.emailVerification.send', 'POST', '/api/v1/account/email-verification/send'],
        ['account.invitation.send', 'POST', '/api/v1/account/invitations'],
        ['account.invitation.list', 'GET', '/api/v1/account/invitations'],
        ['account.invitation.resend', 'POST', '/api/v1/account/invitations/:id/resend'],
        ['account.invitation.revoke', 'DELETE', '/api/v1/account/invitations/:id'],
      ]
    )
    assert.deepEqual(
      routes.filter((route) => route.proof).map((route) => [route.name, route.method]),
      [
        ['auth.passwordReset.inspect', 'GET'],
        ['auth.passwordReset.complete', 'POST'],
        ['auth.emailVerification.inspect', 'GET'],
        ['auth.emailVerification.complete', 'POST'],
        ['auth.invitation.inspect', 'GET'],
        ['auth.invitation.accept', 'POST'],
        ['auth.emailChange.inspect', 'GET'],
        ['auth.emailChange.complete', 'POST'],
      ]
    )
  })

  test('is opt-in, keeps named exclusions out, and limits routes to enabled capabilities', ({
    assert,
  }) => {
    const routes = planManagedRoutes({
      prefix: '/api/v1',
      strategy: 'access_tokens',
      enabled: ['authentication', 'passwordReset'],
      except: ['auth.login'],
    })
    assert.isFalse(routes.some((route) => route.name === 'auth.login'))
    assert.isTrue(routes.some((route) => route.name === 'auth.passwordReset.request'))
    assert.isFalse(routes.some((route) => route.name === 'account.invitation.send'))
    assert.isFalse(routes.some((route) => route.name === 'auth.csrf'))
    assert.equal(
      routes.find((route) => route.name === 'account.profile.show')?.path,
      '/api/v1/account/profile'
    )
  })

  test('session-only write selections include CSRF bootstrap unless explicitly replaced', ({
    assert,
  }) => {
    for (const capability of ['registration', 'passwordReset', 'invitations'] as const) {
      const routes = planManagedRoutes({
        prefix: '/api/v1',
        strategy: 'session',
        enabled: [capability],
      })
      assert.isTrue(routes.some((route) => route.name === 'auth.csrf'))
    }
    const excluded = planManagedRoutes({
      prefix: '/api/v1',
      strategy: 'session',
      enabled: ['registration'],
      except: ['auth.csrf'],
    })
    assert.isFalse(excluded.some((route) => route.name === 'auth.csrf'))
    const token = planManagedRoutes({
      prefix: '/api/v1',
      strategy: 'access_tokens',
      enabled: ['registration'],
    })
    assert.isFalse(token.some((route) => route.name === 'auth.csrf'))
  })

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
      ])
    )
  })

  test('rejects duplicate managed groups, unknown endpoints, and malformed prefixes', ({
    assert,
  }) => {
    assert.throws(() =>
      planManagedRoutes(
        { prefix: '/api/v1', strategy: 'session', enabled: ['authentication'] },
        [],
        true
      )
    )
    assert.throws(() =>
      planManagedRoutes({
        prefix: '/api/v1',
        strategy: 'session',
        enabled: ['authentication'],
        except: ['missing' as never],
      })
    )
    assert.throws(() =>
      planManagedRoutes({ prefix: '/api/:id', strategy: 'session', enabled: ['authentication'] })
    )
  })
})
