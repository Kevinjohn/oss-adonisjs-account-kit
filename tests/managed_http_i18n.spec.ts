import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import type { AccountKit } from '../src/account_kit.js'
import { EmailAlreadyRegisteredError, ThrottledError } from '../src/errors.js'
import { registerManagedRoutes } from '../src/http/managed.js'
import { fakeManagedHttp } from './helpers/managed_http_fakes.js'

const french: Record<string, string> = {
  'errors.E_ACCOUNT_KIT_THROTTLED': 'Trop de requêtes.',
  'errors.E_ACCOUNT_KIT_INVALID_PASSWORD_TOKEN': 'Ce lien est invalide ou expiré.',
  'validator.shared.messages.passwordPolicy': 'Le {field} est refusé.',
  'validator.shared.messages.unique': 'Le champ {field} est déjà utilisé.',
  'validator.shared.fields.password': 'mot de passe',
  'validator.shared.fields.email': 'e-mail',
  'account_kit.password_reset_requested': 'Si le compte existe, les instructions seront envoyées.',
  'account_kit.magic_link_requested': 'Si le compte existe, un lien de connexion sera envoyé.',
}
const i18n = {
  t: (identifier: string, data: Record<string, unknown>, fallbackMessage: string) =>
    (french[identifier] ?? fallbackMessage).replace(/\{(\w+)\}/g, (_, name) => String(data[name])),
}

function mount(
  kit: unknown,
  enabled: ('passwordReset' | 'registration' | 'magicLinkLogin')[] = ['passwordReset']
) {
  const { router, routes, context } = fakeManagedHttp()
  registerManagedRoutes(router, {
    prefix: '/api/v1',
    kit: async () => kit as AccountKit,
    guard: {
      strategy: 'access_tokens',
      name: 'api',
      forRequest: () => ({}) as never,
      current: async () => ({ userId: 1, tokenId: 1 }),
      publicCredential: () => 'token',
    },
    enabled,
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
        errors: [
          {
            code: 'E_ACCOUNT_KIT_INVALID_PASSWORD_TOKEN',
            message: 'Ce lien est invalide ou expiré.',
          },
        ],
      },
    })
  })

  test('password policy and duplicate email messages use the request i18n instance', async ({
    assert,
  }) => {
    const { routes, context } = mount({
      managedHttp: { assertGuard: () => {}, consume: async () => {}, passwordAllowed: () => false },
    })
    const reset = Object.assign(context({ token: 'proof' }), { i18n })
    assert.deepEqual(await routes.get('POST /api/v1/auth/password-reset/:token')!(reset), {
      status: 422,
      body: {
        errors: [
          { field: 'password', rule: 'passwordPolicy', message: 'Le mot de passe est refusé.' },
        ],
      },
    })
    const { routes: signup, context: signupContext } = mount(
      {
        managedHttp: {
          assertGuard: () => {},
          consume: async () => {},
          passwordAllowed: () => true,
          assertPublicRegistration: () => {},
        },
        registration: {
          register: async () => {
            throw new EmailAlreadyRegisteredError()
          },
        },
      },
      ['registration']
    )
    const ctx = Object.assign(signupContext(), { i18n })
    assert.deepEqual(await signup.get('POST /api/v1/auth/signup')!(ctx), {
      status: 422,
      body: {
        errors: [{ field: 'email', rule: 'unique', message: 'Le champ e-mail est déjà utilisé.' }],
      },
    })
  })

  test('request acknowledgements use the request i18n instance', async ({ assert }) => {
    const { routes, context } = mount(
      {
        managedHttp: { assertGuard: () => {}, consume: async () => {} },
        passwordReset: { request: async () => {} },
        magicLink: { request: async () => {} },
      },
      ['passwordReset', 'magicLinkLogin']
    )
    const run = (key: string, translated: boolean) => {
      const ctx = context()
      ctx.request.validateUsing = (async () => ({
        email: 'a@example.test',
        clientChallenge: 'challenge',
      })) as never
      return routes.get(key)!(translated ? Object.assign(ctx, { i18n }) : ctx)
    }
    assert.deepEqual(await run('POST /api/v1/auth/password-reset', true), {
      status: 202,
      body: { message: 'Si le compte existe, les instructions seront envoyées.' },
    })
    assert.deepEqual(await run('POST /api/v1/auth/password-reset', false), {
      status: 202,
      body: { message: 'If the account exists, instructions will be sent.' },
    })
    assert.deepEqual(await run('POST /api/v1/auth/magic-link', true), {
      status: 202,
      body: { message: 'Si le compte existe, un lien de connexion sera envoyé.' },
    })
    assert.deepEqual(await run('POST /api/v1/auth/magic-link', false), {
      status: 202,
      body: { message: 'If the account exists, a sign-in link will be sent.' },
    })
  })
})
