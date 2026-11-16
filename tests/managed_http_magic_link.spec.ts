import { test } from '@japa/runner'
import { registerManagedRoutes } from '../src/http/managed.js'
import { clientChallengeFor } from '../src/magic_link.js'
import { hashToken } from '../src/tokens.js'
import type { AccountKitConfig, UserId } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService, tokenFrom } from './helpers/fakes.js'
import { fakeManagedHttp, sessionStore, stubGuard } from './helpers/managed_http_fakes.js'

type Validator = { validate(data: unknown): Promise<unknown> }

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
    const guard = stubGuard<string>({
      strategy,
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
    })
    const { router, routes, context } = fakeManagedHttp()
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
    const verifier = (store.values.get('accountKit.magicLink.verifier') as { verifier: string })
      .verifier
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
    for (const body of [
      {},
      {
        verifier: (store.values.get('accountKit.magicLink.verifier') as { verifier: string })
          .verifier,
      },
    ]) {
      const other = await call('POST /api/v1/auth/magic-link/:token', body, {
        token,
        session: sessionStore(),
      })
      assert.equal(other.status, 400)
      assert.deepEqual(other.body, {
        errors: [
          { code: 'E_ACCOUNT_KIT_INVALID_MAGIC_LINK', message: 'This link is invalid or expired.' },
        ],
      })
    }
    assert.isTrue(await service.account.magicLink.inspect({ token }))
  })

  test('overlapping accounts and an unknown address retain the browser binding', async ({
    assert,
  }) => {
    const first = await insertUser(kit)
    const second = await insertUser(kit, { email: 'second@example.test' })
    const { call, store, service, linkToken, established } = mount('session')
    const a = await call('POST /api/v1/auth/magic-link', { email: first.email })
    const firstToken = linkToken()
    const unknown = await call('POST /api/v1/auth/magic-link', { email: 'unknown@example.test' })
    const b = await call('POST /api/v1/auth/magic-link', { email: second.email })
    const secondToken = linkToken()
    assert.deepEqual(a, unknown)
    assert.deepEqual(a, b)
    const completion1 = await call(
      'POST /api/v1/auth/magic-link/:token',
      {},
      { token: secondToken }
    )
    assert.equal(completion1.status, 200)
    const completion2 = await call(
      'POST /api/v1/auth/magic-link/:token',
      {},
      { token: secondToken }
    )
    assert.equal(completion2.status, 400)
    assert.isTrue(await service.account.magicLink.inspect({ token: firstToken }))
    const completion3 = await call('POST /api/v1/auth/magic-link/:token', {}, { token: firstToken })
    assert.equal(completion3.status, 200)
    assert.deepEqual(established, [
      [second.id, null],
      [first.id, null],
    ])
    assert.equal(
      (store.values.get('accountKit.magicLink.verifier') as { outstanding: number }).outstanding,
      1
    )
  })

  test('two outstanding links clean up after both completions', async ({ assert }) => {
    const first = await insertUser(kit)
    const second = await insertUser(kit, { email: 'other@example.test' })
    const { call, store, linkToken } = mount('session')
    await call('POST /api/v1/auth/magic-link', { email: first.email })
    const firstToken = linkToken()
    await call('POST /api/v1/auth/magic-link', { email: second.email })
    const secondToken = linkToken()
    const completion4 = await call(
      'POST /api/v1/auth/magic-link/:token',
      {},
      { token: secondToken }
    )
    assert.equal(completion4.status, 200)
    const completion5 = await call('POST /api/v1/auth/magic-link/:token', {}, { token: firstToken })
    assert.equal(completion5.status, 200)
    assert.isFalse(store.values.has('accountKit.magicLink.verifier'))
  })

  test('reissue replaces its proof while retaining a bounded binding until expiry', async ({
    assert,
    cleanup,
  }) => {
    const originalNow = Date.now
    let now = originalNow()
    Date.now = () => now
    cleanup(() => {
      Date.now = originalNow
    })
    const user = await insertUser(kit)
    const { call, store, linkToken, service } = mount('session', { expiresIn: { magicLink: '2m' } })
    await call('POST /api/v1/auth/magic-link', { email: user.email })
    const replaced = linkToken()
    const initial = store.values.get('accountKit.magicLink.verifier') as {
      verifier: string
      expiresAt: number
    }
    assert.equal(initial.expiresAt, now + 120_000)
    now += 30_000
    await call('POST /api/v1/auth/magic-link', { email: user.email })
    const live = linkToken()
    const extended = store.values.get('accountKit.magicLink.verifier') as typeof initial
    assert.equal(extended.verifier, initial.verifier)
    assert.equal(extended.expiresAt, now + 120_000)
    assert.isFalse(await service.account.magicLink.inspect({ token: replaced }))
    const completion6 = await call('POST /api/v1/auth/magic-link/:token', {}, { token: live })
    assert.equal(completion6.status, 200)
    assert.isTrue(store.values.has('accountKit.magicLink.verifier'))
    now = extended.expiresAt
    const completion7 = await call('POST /api/v1/auth/magic-link/:token', {}, { token: live })
    assert.equal(completion7.status, 400)
    assert.isFalse(store.values.has('accountKit.magicLink.verifier'))
  })

  test('legacy verifier strings complete directly and survive adoption by another request', async ({
    assert,
  }) => {
    const first = await insertUser(kit)
    const second = await insertUser(kit, { email: 'legacy-other@example.test' })
    const { call, store, linkToken } = mount('session')
    for (const adopt of [false, true]) {
      await call('POST /api/v1/auth/magic-link', { email: first.email })
      const token = linkToken()
      const binding = store.values.get('accountKit.magicLink.verifier') as { verifier: string }
      store.put('accountKit.magicLink.verifier', binding.verifier)
      let otherToken: string | undefined
      if (adopt) {
        await call('POST /api/v1/auth/magic-link', { email: second.email })
        otherToken = linkToken()
      }
      const completion8 = await call('POST /api/v1/auth/magic-link/:token', {}, { token })
      assert.equal(completion8.status, 200)
      if (otherToken) {
        const completion9 = await call(
          'POST /api/v1/auth/magic-link/:token',
          {},
          { token: otherToken }
        )
        assert.equal(completion9.status, 200)
      }
      assert.isFalse(store.values.has('accountKit.magicLink.verifier'))
    }
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
      clientChallengeFor(
        (store.values.get('accountKit.magicLink.verifier') as { verifier: string }).verifier
      )
    )
  })

  test('session writes require Shield CSRF middleware', async ({ assert }) => {
    const { call } = mount('session')
    await assert.rejects(
      () => call('POST /api/v1/auth/magic-link', { email: 'a@example.test' }, { csrf: false }),
      /require Shield CSRF middleware/
    )
  })

  test('session guards refuse a request without session middleware', async ({ assert }) => {
    const user = await insertUser(kit)
    const { call, service } = mount('session')
    await assert.rejects(
      () => call('POST /api/v1/auth/magic-link', { email: user.email }, { session: {} as never }),
      /require persistent AdonisJS session middleware/
    )
    assert.isUndefined(service.recorder.calls.find((c) => c.method === 'magicLinkProvision'))
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
    assert.equal(noVerifier.body.errors[0].code, 'E_ACCOUNT_KIT_INVALID_MAGIC_LINK')
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
    assert.equal(invalid.body.errors[0].code, 'E_ACCOUNT_KIT_INVALID_MAGIC_LINK')
    assert.equal(invalid.headers.Vary, 'Accept')
  })

  test('access-token mounts require publicCredential', ({ assert }) => {
    const { router } = fakeManagedHttp()
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

  test('access-token mounts with logout require logoutCredential', ({ assert }) => {
    const { router } = fakeManagedHttp()
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
            publicCredential: () => 'token',
          },
          enabled: ['authentication'],
        }),
      /logout requires logoutCredential/
    )
  })
})
