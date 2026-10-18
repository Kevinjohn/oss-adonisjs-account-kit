import { test } from '@japa/runner'
import { registerManagedRoutes, type ManagedGuard } from '../src/http/managed.js'
import { planManagedRoutes } from '../src/http/routes.js'
import { clientChallengeFor } from '../src/magic_link.js'
import { hashToken } from '../src/tokens.js'
import type { AccountKitConfig, UserId } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService, tokenFrom } from './helpers/fakes.js'
import { fixture } from './helpers/managed_http.js'

type Validator = { validate(data: unknown): Promise<unknown> }

function sessionStore() {
  const values = new Map<string, unknown>()
  return {
    values,
    get: (key: string) => values.get(key),
    put: (key: string, value: unknown) => void values.set(key, value),
    forget: (key: string) => void values.delete(key),
  }
}

test.group('managed magic-link routes', (group) => {
  const kit = useTestApp(group)

  function mount(strategy: 'session' | 'access_tokens', overrides: Partial<AccountKitConfig> = {}) {
    const service = makeService(kit, {
      enabled: ['magicLinkLogin'],
      authentication: { guard: strategy === 'session' ? 'web' : 'api', strategy },
      minRequestMs: 0,
      ...overrides,
    })
    const established: unknown[] = []
    const guard = {
      strategy,
      name: strategy === 'session' ? 'web' : 'api',
      forRequest: () =>
        ({
          strategy,
          name: strategy === 'session' ? 'web' : 'api',
          establish: async (id: UserId, ...rest: unknown[]) => {
            established.push([id, ...rest])
            return `credential:${id}`
          },
          terminate: async () => {},
        }) as never,
      current: async () => {
        throw new Error('public routes never read the current account')
      },
      publicCredential: (credential: string) => `public:${credential}`,
    } as ManagedGuard<string>
    const { router, routes, context } = fixture()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => service.account,
      guard,
      enabled: ['magicLinkLogin'],
    })
    const store = sessionStore()
    const call = async (
      key: string,
      body: Record<string, unknown> = {},
      options: { token?: string; session?: ReturnType<typeof sessionStore>; csrf?: boolean } = {}
    ) => {
      const ctx = context(options.token ? { token: options.token } : {})
      Object.assign(ctx.request, {
        validateUsing: (validator: Validator) => validator.validate(body),
        ...(strategy === 'session' && options.csrf !== false ? { csrfToken: 'csrf' } : {}),
      })
      if (strategy === 'session')
        (ctx as unknown as { session: unknown }).session = options.session ?? store
      const output = (await routes.get(key)!(ctx)) as { status: number; body?: any }
      return { ...output, headers: ctx.headers }
    }
    const linkToken = () =>
      tokenFrom(service.recorder.calls.findLast((c) => c.method === 'magicLinkProvision')!.args[1])
    return { service, established, call, store, linkToken }
  }

  const generic = { message: 'If the account exists, a sign-in link will be sent.' }

  test('session guards keep the verifier server-side and sign in from the same session', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { call, store, established, linkToken } = mount('session')
    const requested = await call('POST /api/v1/auth/magic-link', { email: user.email })
    assert.deepEqual(requested, { status: 202, body: generic, headers: {} })
    const verifier = store.values.get('accountKit.magicLink.verifier') as string
    assert.match(verifier, /^[\w-]{43}$/)
    const row = await kit.db.from('login_link_tokens').first()
    assert.equal(row.client_challenge, clientChallengeFor(verifier))
    assert.equal(row.hash, hashToken(linkToken()))

    const done = await call('POST /api/v1/auth/magic-link/:token', {}, { token: linkToken() })
    assert.equal(done.status, 200)
    assert.deepEqual(Object.keys(done.body), ['account'])
    assert.equal(done.body.account.id, user.id)
    assert.notProperty(done.body.account, 'password')
    assert.deepEqual(established, [[user.id, null]])
    assert.isFalse(store.values.has('accountKit.magicLink.verifier'))
    assert.equal(done.headers['Cache-Control'], 'no-store')
  })

  test('a session without the verifier cannot use the link and does not consume it', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { call, service, linkToken, store } = mount('session')
    await call('POST /api/v1/auth/magic-link', { email: user.email })
    const token = linkToken()
    for (const body of [{}, { verifier: store.values.get('accountKit.magicLink.verifier') }]) {
      const other = await call('POST /api/v1/auth/magic-link/:token', body, {
        token,
        session: sessionStore(),
      })
      assert.equal(other.status, 400)
      assert.deepEqual(other.body, {
        errors: [{ code: 'E_INVALID_MAGIC_LINK', message: 'This link is invalid or expired.' }],
      })
    }
    assert.isTrue(await service.account.magicLink.inspect({ token }))
  })

  test('a failed completion keeps the session verifier for the live link', async ({ assert }) => {
    const user = await insertUser(kit)
    const { call, linkToken, store } = mount('session')
    await call('POST /api/v1/auth/magic-link', { email: user.email })
    const stale = await call('POST /api/v1/auth/magic-link/:token', {}, { token: 'x'.repeat(43) })
    assert.equal(stale.status, 400)
    assert.isTrue(store.values.has('accountKit.magicLink.verifier'))
    const done = await call('POST /api/v1/auth/magic-link/:token', {}, { token: linkToken() })
    assert.equal(done.status, 200)
  })

  test('a refused request keeps the session verifier for the live link', async ({ assert }) => {
    const user = await insertUser(kit)
    const { call, linkToken, store } = mount('session', {
      throttle: { requests: 1, duration: '1m' },
    })
    await call('POST /api/v1/auth/magic-link', { email: user.email })
    const verifier = store.values.get('accountKit.magicLink.verifier')
    const token = linkToken()
    const refused = await call('POST /api/v1/auth/magic-link', { email: user.email })
    assert.equal(refused.status, 429)
    assert.equal(store.values.get('accountKit.magicLink.verifier'), verifier)
    const done = await call('POST /api/v1/auth/magic-link/:token', {}, { token })
    assert.equal(done.status, 200)
  })

  test('session guards ignore a client-supplied challenge', async ({ assert }) => {
    const user = await insertUser(kit)
    const { call, store } = mount('session')
    await call('POST /api/v1/auth/magic-link', {
      email: user.email,
      clientChallenge: clientChallengeFor('c'.repeat(64)),
    })
    const row = await kit.db.from('login_link_tokens').first()
    assert.equal(
      row.client_challenge,
      clientChallengeFor(store.values.get('accountKit.magicLink.verifier') as string)
    )
  })

  test('session writes require Shield CSRF middleware', async ({ assert }) => {
    const { call } = mount('session')
    await assert.rejects(
      () => call('POST /api/v1/auth/magic-link', { email: 'a@example.test' }, { csrf: false }),
      /require Shield CSRF middleware/
    )
  })

  test('known, unknown and failed requests answer identically', async ({ assert }) => {
    const user = await insertUser(kit)
    const delivery = mount('session')
    delivery.service.recorder.failOn('magicLinkProvision')
    const observer = mount('session', {
      onLifecycleEvent: async () => {
        throw new Error('observer down')
      },
    })
    const outputs = [
      await mount('session').call('POST /api/v1/auth/magic-link', { email: 'nobody@example.test' }),
      await delivery.call('POST /api/v1/auth/magic-link', { email: user.email }),
      await observer.call('POST /api/v1/auth/magic-link', { email: user.email }),
    ]
    for (const output of outputs)
      assert.deepEqual(output, { status: 202, body: generic, headers: {} })
    assert.lengthOf(observer.service.recorder.calls, 1)
  })

  test('access-token clients hold their own verifier', async ({ assert }) => {
    const user = await insertUser(kit)
    const { call, established, linkToken } = mount('access_tokens')
    const verifier = 'c'.repeat(64)
    const missing = await call('POST /api/v1/auth/magic-link', { email: user.email })
    assert.equal(missing.status, 422)
    assert.equal(missing.body.errors[0].code, 'E_ACCOUNT_KIT_INVALID_INPUT')
    const requested = await call('POST /api/v1/auth/magic-link', {
      email: user.email,
      clientChallenge: clientChallengeFor(verifier),
    })
    assert.deepEqual(requested, { status: 202, body: generic, headers: {} })

    const token = linkToken()
    const noVerifier = await call('POST /api/v1/auth/magic-link/:token', {}, { token })
    assert.equal(noVerifier.body.errors[0].code, 'E_INVALID_MAGIC_LINK')
    const done = await call('POST /api/v1/auth/magic-link/:token', { verifier }, { token })
    assert.equal(done.status, 200)
    assert.equal(done.body.token, `public:credential:${user.id}`)
    assert.equal(done.body.account.id, user.id)
    assert.deepEqual(established, [[user.id, ['*'], null]])
    const again = await call('POST /api/v1/auth/magic-link/:token', { verifier }, { token })
    assert.equal(again.status, 400)
  })

  test('a wrong verifier burns the link', async ({ assert }) => {
    const user = await insertUser(kit)
    const { call, linkToken, service } = mount('access_tokens')
    await call('POST /api/v1/auth/magic-link', {
      email: user.email,
      clientChallenge: clientChallengeFor('c'.repeat(64)),
    })
    const token = linkToken()
    const wrong = await call(
      'POST /api/v1/auth/magic-link/:token',
      { verifier: 'd'.repeat(64) },
      { token }
    )
    assert.equal(wrong.status, 400)
    assert.isFalse(await service.account.magicLink.inspect({ token }))
  })

  test('inspection is read-only and maps an invalid link to its own code', async ({ assert }) => {
    const user = await insertUser(kit)
    const { call, linkToken, service } = mount('access_tokens')
    await call('POST /api/v1/auth/magic-link', {
      email: user.email,
      clientChallenge: clientChallengeFor('c'.repeat(64)),
    })
    const token = linkToken()
    for (let index = 0; index < 2; index++) {
      const output = await call('GET /api/v1/auth/magic-link/:token', {}, { token })
      assert.deepEqual(output.body, { valid: true })
      assert.equal(output.headers['Referrer-Policy'], 'no-referrer')
    }
    assert.isTrue(await service.account.magicLink.inspect({ token }))
    const invalid = await call('GET /api/v1/auth/magic-link/:token', {}, { token: 'y'.repeat(43) })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.errors[0].code, 'E_INVALID_MAGIC_LINK')
    assert.equal(invalid.headers.Vary, 'Accept')
  })

  test('access-token mounts require publicCredential', ({ assert }) => {
    const { router } = fixture()
    assert.throws(
      () =>
        registerManagedRoutes(router, {
          prefix: '/api/v1',
          kit: async () => ({}) as never,
          guard: {
            strategy: 'access_tokens',
            name: 'api',
            forRequest: () => ({}) as never,
            current: async () => ({ userId: 1, tokenId: 1 }),
          },
          enabled: ['magicLinkLogin'],
        }),
      /require publicCredential/
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
})
