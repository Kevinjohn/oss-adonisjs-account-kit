import { test } from '@japa/runner'
import { managedProofHeadersMiddleware } from '../src/http/proof_headers.js'

test.group('early managed proof headers', () => {
  test('protects every selected proof URL even when later middleware rejects the request', async ({
    assert,
  }) => {
    const early = managedProofHeadersMiddleware({
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
          early(context, async () => {
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
    const early = managedProofHeadersMiddleware({
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
      await early(
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
    const early = managedProofHeadersMiddleware({
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
        early(
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
