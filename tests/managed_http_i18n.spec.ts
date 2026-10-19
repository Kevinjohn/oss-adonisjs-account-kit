import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import type { AccountKit } from '../src/account_kit.js'
import { ThrottledError } from '../src/errors.js'
import { registerManagedRoutes } from '../src/http/managed.js'
import { fixture } from './helpers/managed_http.js'

const french: Record<string, string> = {
  'errors.E_ACCOUNT_KIT_THROTTLED': 'Trop de requêtes.',
  'errors.E_INVALID_PASSWORD_TOKEN': 'Ce lien est invalide ou expiré.',
}
const i18n = {
  t: (identifier: string, _data: Record<string, unknown>, fallbackMessage: string) =>
    french[identifier] ?? fallbackMessage,
}

function mount(kit: unknown) {
  const { router, routes, context } = fixture()
  registerManagedRoutes(router, {
    prefix: '/api/v1',
    kit: async () => kit as AccountKit,
    guard: {
      strategy: 'access_tokens',
      name: 'api',
      forRequest: () => ({}) as never,
      current: async () => ({ userId: 1, tokenId: 1 }),
    },
    enabled: ['passwordReset'],
  })
  return { routes, context }
}

test.group('managed HTTP translation', () => {
  test('route errors use the request i18n instance when the app has one', async ({ assert }) => {
    const { routes, context } = mount({
      managedHttp: { assertGuard: () => {}, consume: async () => {} },
      passwordReset: {
        request: async () => {
          throw new ThrottledError(5)
        },
      },
    })
    const run = (ctx: HttpContext) => routes.get('POST /api/v1/auth/password-reset')!(ctx)
    assert.deepEqual(await run(Object.assign(context(), { i18n })), {
      status: 429,
      body: { errors: [{ code: 'E_ACCOUNT_KIT_THROTTLED', message: 'Trop de requêtes.' }] },
    })
    assert.deepEqual(await run(context()), {
      status: 429,
      body: { errors: [{ code: 'E_ACCOUNT_KIT_THROTTLED', message: 'Too many requests.' }] },
    })
  })

  test('invalid proof responses use the request i18n instance', async ({ assert }) => {
    const { routes, context } = mount({
      managedHttp: { assertGuard: () => {}, consume: async () => {} },
      passwordReset: { inspect: async () => false },
    })
    const ctx = Object.assign(context({ token: 'proof' }), { i18n })
    assert.deepEqual(await routes.get('GET /api/v1/auth/password-reset/:token')!(ctx), {
      status: 400,
      body: {
        errors: [{ code: 'E_INVALID_PASSWORD_TOKEN', message: 'Ce lien est invalide ou expiré.' }],
      },
    })
  })
})
