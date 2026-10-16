import { test } from '@japa/runner'
import { planManagedRoutes } from '../src/http/routes.js'

test.group('managed social route plan', () => {
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
