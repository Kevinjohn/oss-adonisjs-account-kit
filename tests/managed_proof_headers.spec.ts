import ManagedProofHeadersMiddleware from '../src/http/managed_proof_headers_middleware.ts'
import { test } from '@japa/runner'
import { ManagedRoutes } from '../src/http/route_registration.ts'
import { HttpContextFactory, RouterFactory } from '@adonisjs/core/factories/http'

test.group('early managed proof headers', () => {
  test('finds registered proof routes through the request container without a selection', async ({
    assert,
  }) => {
    const router = new RouterFactory().create()
    const middleware = router.named({
      proof: () => import('../src/http/managed_proof_headers_middleware.ts'),
    })
    const managedRoutes = new ManagedRoutes()
    managedRoutes.register(router, {
      prefix: '/account',
      guard: {
        strategy: 'session',
        name: 'web',
        forRequest: () => {
          throw new Error('unexpected guard call')
        },
        current: async () => {
          throw new Error('unexpected authentication')
        },
      },
      kit: async () => {
        throw new Error('unexpected service resolution')
      },
      enabled: ['passwordReset'],
      except: ['auth.passwordReset.inspect'],
    })

    for (const [method, url, protect] of [
      ['POST', '/account/auth/password-reset/proof?ignored=true', true],
      ['GET', '/account/auth/password-reset/proof', false],
      ['POST', '/account/auth/login', false],
    ] as const) {
      const context = new HttpContextFactory().merge({ method, url }).create()
      context.containerResolver.bindValue('router', router)
      context.containerResolver.bindValue('account_kit.managed_routes', managedRoutes)
      await assert.rejects(
        () =>
          middleware.proof().handle(context.containerResolver, context, async () => {
            throw new Error('body parser rejected request')
          }),
        /body parser rejected request/
      )
      assert.equal(context.response.getHeader('Cache-Control'), protect ? 'no-store' : undefined)
      assert.equal(
        context.response.getHeader('Referrer-Policy'),
        protect ? 'no-referrer' : undefined
      )
    }
  })

  test('protects every selected proof URL even when later middleware rejects the request', async ({
    assert,
  }) => {
    const early = new ManagedProofHeadersMiddleware({
      prefix: '/api/v1',
      strategy: 'session',
      enabled: ['passwordReset', 'emailVerification', 'emailPasswordManagement', 'invitations'],
    })
    for (const suffix of ['password-reset', 'email-verification', 'email-change', 'invitations']) {
      for (const method of ['GET', 'POST']) {
        const headers: Record<string, string> = {}
        const context = {
          request: { method: () => method, url: () => `/api/v1/auth/${suffix}/secret-proof` },
          response: { header: (name: string, value: string) => (headers[name] = value) },
        } as never
        await assert.rejects(() =>
          early.handle(context, async () => {
            throw new Error('parser or Shield rejected request')
          })
        )
        assert.deepEqual(headers, {
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        })
      }
    }
  })

  test('does not claim excluded or unrelated routes', async ({ assert }) => {
    const early = new ManagedProofHeadersMiddleware({
      prefix: '/api/v1',
      strategy: 'session',
      enabled: ['passwordReset'],
      except: ['auth.passwordReset.inspect'],
    })
    for (const [method, path, expected] of [
      ['GET', '/api/v1/auth/password-reset/proof', false],
      ['POST', '/api/v1/auth/password-reset/proof', true],
      ['POST', '/api/v1/auth/login', false],
    ] as const) {
      const headers: Record<string, string> = {}
      await early.handle(
        {
          request: { method: () => method, url: () => path },
          response: { header: (name: string, value: string) => (headers[name] = value) },
        } as never,
        async () => undefined
      )
      assert.equal(headers['Cache-Control'] === 'no-store', expected)
    }
  })

  test('token callback and exchange keep proof headers on early rejection and respect exclusions', async ({
    assert,
  }) => {
    const early = new ManagedProofHeadersMiddleware({
      prefix: '/api/v1',
      strategy: 'access_tokens',
      enabled: ['socialAuthentication'],
      except: ['auth.oauth.redirect'],
    })
    for (const [method, path, protectedRoute] of [
      ['POST', '/api/v1/auth/oauth/google/callback', true],
      ['POST', '/api/v1/auth/oauth/token', true],
      ['POST', '/api/v1/auth/oauth/google/redirect', false],
      ['GET', '/api/v1/auth/oauth/google/callback', true],
    ] as const) {
      const headers: Record<string, string> = {}
      await assert.rejects(() =>
        early.handle(
          {
            request: { method: () => method, url: () => path },
            response: { header: (name: string, value: string) => (headers[name] = value) },
          } as never,
          async () => {
            throw new Error('parser or CSRF rejected request')
          }
        )
      )
      assert.deepEqual(
        headers,
        protectedRoute
          ? {
              'Cache-Control': 'no-store',
              'Referrer-Policy': 'no-referrer',
            }
          : {}
      )
    }
  })
})
