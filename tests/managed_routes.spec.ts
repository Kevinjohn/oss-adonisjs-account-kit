import { test } from '@japa/runner'
import { managedHandlers, type ManagedHandler } from '../src/http/managed.js'
import { planManagedRoutes, type ManagedEndpointName } from '../src/http/routes.js'

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

  test('names the token kind on each proof route that reports invalid tokens', ({ assert }) => {
    const routes = planManagedRoutes({
      prefix: '/api',
      strategy: 'access_tokens',
      enabled: [
        'passwordReset',
        'magicLinkLogin',
        'emailVerification',
        'emailPasswordManagement',
        'invitations',
        'socialAuthentication',
      ],
    })
    assert.deepEqual(
      routes.filter((route) => route.proofKind).map((route) => [route.name, route.proofKind]),
      [
        ['auth.passwordReset.inspect', 'password'],
        ['auth.passwordReset.complete', 'password'],
        ['auth.magicLink.inspect', 'magicLink'],
        ['auth.magicLink.complete', 'magicLink'],
        ['auth.emailVerification.inspect', 'email'],
        ['auth.emailVerification.complete', 'email'],
        ['auth.invitation.inspect', 'invitation'],
        ['auth.invitation.accept', 'invitation'],
        ['auth.emailChange.inspect', 'email'],
        ['auth.emailChange.complete', 'email'],
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

  test('every planned endpoint has a handler and a missing handler does not compile', ({
    assert,
  }) => {
    const withoutCsrf: Omit<
      Record<ManagedEndpointName, ManagedHandler>,
      'auth.csrf'
    > = managedHandlers
    // @ts-expect-error a handler table without an entry for a defined endpoint is rejected
    const incomplete: Record<ManagedEndpointName, ManagedHandler> = withoutCsrf
    assert.isFunction(incomplete['auth.login'])
    for (const strategy of ['session', 'access_tokens'] as const) {
      const routes = planManagedRoutes({
        prefix: '/api/v1',
        strategy,
        enabled: [
          'authentication',
          'registration',
          'passwordReset',
          'emailVerification',
          'emailPasswordManagement',
          'invitations',
          'socialAuthentication',
        ],
      })
      for (const route of routes) assert.isFunction(managedHandlers[route.name], route.name)
    }
  })

  test('the route plan publishes export and delete as limited routes', ({ assert }) => {
    const routes = planManagedRoutes({
      prefix: '/api/v1',
      strategy: 'access_tokens',
      enabled: ['dataExport', 'accountDeletion'],
    })
    assert.deepEqual(
      routes.map(({ name, method, path, access, proof }) => [name, method, path, access, proof]),
      [
        ['account.data.export', 'POST', '/api/v1/account/export', 'limited', undefined],
        ['account.delete', 'DELETE', '/api/v1/account', 'limited', undefined],
      ]
    )
  })

  test('the route plan publishes request, inspect and complete', ({ assert }) => {
    for (const strategy of ['session', 'access_tokens'] as const) {
      const routes = planManagedRoutes({ prefix: '/api/v1', strategy, enabled: ['magicLinkLogin'] })
      assert.deepEqual(
        routes
          .filter((route) => route.capability === 'magicLinkLogin')
          .map(({ name, method, path, access, proof }) => [name, method, path, access, proof]),
        [
          ['auth.magicLink.request', 'POST', '/api/v1/auth/magic-link', 'public', undefined],
          ['auth.magicLink.inspect', 'GET', '/api/v1/auth/magic-link/:token', 'public', true],
          ['auth.magicLink.complete', 'POST', '/api/v1/auth/magic-link/:token', 'public', true],
        ]
      )
      assert.equal(
        routes.some((route) => route.name === 'auth.csrf'),
        strategy === 'session'
      )
    }
  })

  test('the route plan publishes list, revoke, revoke others and revoke all', ({ assert }) => {
    for (const strategy of ['session', 'access_tokens'] as const) {
      const routes = planManagedRoutes({
        prefix: '/api/v1',
        strategy,
        enabled: ['sessionManagement'],
      })
      assert.deepEqual(
        routes
          .filter((route) => route.capability === 'sessionManagement')
          .map(({ name, method, path, access }) => [name, method, path, access]),
        [
          ['account.sessions.list', 'GET', '/api/v1/account/sessions', 'limited'],
          ['account.sessions.revoke', 'DELETE', '/api/v1/account/sessions/:id', 'limited'],
          [
            'account.sessions.revokeOthers',
            'POST',
            '/api/v1/account/sessions/revoke-others',
            'limited',
          ],
          ['account.sessions.revokeAll', 'POST', '/api/v1/account/sessions/revoke-all', 'limited'],
        ]
      )
    }
  })

  test('publishes selected social operations and excludes token exchange for sessions', ({
    assert,
  }) => {
    const session = planManagedRoutes({
      prefix: '/api/v1',
      strategy: 'session',
      enabled: ['socialAuthentication'],
    })
    assert.deepEqual(
      session.map(({ name, method, path }) => [name, method, path]),
      [
        ['auth.csrf', 'GET', '/api/v1/auth/csrf'],
        ['auth.oauth.redirect', 'POST', '/api/v1/auth/oauth/:provider/redirect'],
        ['auth.oauth.callback', 'GET', '/api/v1/auth/oauth/:provider/callback'],
        ['auth.oauth.registration', 'POST', '/api/v1/auth/oauth/registration'],
        ['auth.oauth.confirmation', 'POST', '/api/v1/auth/oauth/:provider/confirmation'],
        ['auth.methods', 'GET', '/api/v1/auth/methods'],
        ['account.socialProof.password', 'POST', '/api/v1/account/social-proof/password'],
        ['account.socialIdentities.list', 'GET', '/api/v1/account/social-identities'],
        ['account.socialIdentities.unlink', 'DELETE', '/api/v1/account/social-identities/:id'],
      ]
    )
    const tokens = planManagedRoutes({
      prefix: '/api/v1',
      strategy: 'access_tokens',
      enabled: ['socialAuthentication'],
    })
    assert.isTrue(tokens.some(({ name }) => name === 'auth.oauth.token'))
    assert.isFalse(session.some(({ name }) => name === 'auth.oauth.token'))
    assert.isTrue(session.find(({ name }) => name === 'auth.oauth.callback')?.proof)
    assert.isTrue(session.find(({ name }) => name === 'account.socialIdentities.unlink')?.proof)
  })
})
