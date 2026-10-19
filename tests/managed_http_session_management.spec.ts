import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { registerManagedRoutes, type ManagedGuard } from '../src/http/managed.js'
import type { AccountKitConfig, CurrentAccountInput, UserId } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { fakeManagedHttp } from './helpers/managed_http_fakes.js'
import { dbTime } from './helpers/db_time.js'

type Validator = { validate(data: unknown): Promise<unknown> }

const credentials = { email: 'person@example.test', password: 'password123' }

test.group('managed sign-in management routes', (group) => {
  const kit = useTestApp(group)

  /**
   * Mount the managed routes over a real service. The guard keeps one "browser" per sign-in:
   * `as(input)` makes the next request come from that sign-in.
   */
  function mount(strategy: 'session' | 'access_tokens', overrides: Partial<AccountKitConfig> = {}) {
    const service = makeService(kit, {
      enabled: ['sessionManagement'],
      authentication: { guard: strategy === 'session' ? 'web' : 'api', strategy },
      minRequestMs: 0,
      ...overrides,
    })
    const terminated: unknown[] = []
    const issued: CurrentAccountInput[] = []
    const established: unknown[][] = []
    const warnings: unknown[] = []
    let failTerminate = false
    let caller: CurrentAccountInput | undefined
    const guard = {
      strategy,
      name: strategy === 'session' ? 'web' : 'api',
      forRequest: () =>
        ({
          strategy,
          name: strategy === 'session' ? 'web' : 'api',
          establish: async (userId: UserId, ...rest: unknown[]) => {
            established.push([userId, ...rest])
            issued.push({
              userId,
              revision: rest[0] as string | null,
              sessionHandle: rest[1] as string | undefined,
            })
            return `credential:${userId}`
          },
          terminate: async (credential?: unknown) => {
            if (failTerminate) throw new Error('session store down')
            terminated.push(credential ?? 'session')
          },
        }) as never,
      current: async () => caller!,
      publicCredential: (credential: string) => `public:${credential}`,
    } as ManagedGuard<string>
    const { router, routes, context } = fakeManagedHttp()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => service.account,
      guard,
      enabled: ['authentication', 'sessionManagement'],
    })
    const call = async (
      key: string,
      options: {
        as?: CurrentAccountInput
        params?: Record<string, string>
        body?: Record<string, unknown>
        userAgent?: string
        csrf?: boolean
      } = {}
    ) => {
      caller = options.as
      const ctx = context(options.params ?? {})
      Object.assign(ctx, { logger: { warn: (...args: unknown[]) => void warnings.push(args) } })
      Object.assign(ctx.request, {
        validateUsing: (validator: Validator) => validator.validate(options.body ?? {}),
        header: (name: string) => (name === 'user-agent' ? options.userAgent : undefined),
        ...(strategy === 'session' && options.csrf !== false ? { csrfToken: 'csrf' } : {}),
      })
      return (await routes.get(key)!(ctx)) as { status: number; body?: any }
    }
    const signIn = async (userAgent?: string) => {
      const output = await call('POST /api/v1/auth/login', { body: credentials, userAgent })
      if (output.status !== 200) throw new Error(`login failed: ${output.status}`)
      return issued.at(-1)!
    }
    const failTerminateNext = () => {
      failTerminate = true
    }
    return { service, call, signIn, terminated, established, warnings, failTerminateNext }
  }

  test('session login labels the sign-in with the User-Agent and lists it', async ({ assert }) => {
    const user = await insertUser(kit)
    const { call, signIn, established } = mount('session')
    const phone = await signIn('Phone/1.0')
    const laptop = await signIn('x'.repeat(300))
    assert.match(established[0][2] as string, /^[\w-]{43}$/)
    const listed = await call('GET /api/v1/account/sessions', { as: phone })
    assert.equal(listed.status, 200)
    assert.deepEqual(
      listed.body.sessions.map(({ label, current }: any) => [label, current]),
      [
        ['x'.repeat(255), false],
        ['Phone/1.0', true],
      ]
    )
    assert.sameMembers(Object.keys(listed.body.sessions[0]), [
      'id',
      'label',
      'createdAt',
      'lastSeenAt',
      'expiresAt',
      'current',
    ])
    const fromLaptop = await call('GET /api/v1/account/sessions', { as: laptop })
    assert.deepEqual(
      fromLaptop.body.sessions.map(({ current }: any) => current),
      [true, false]
    )
    assert.equal(String(user.id), String(laptop.userId))
  })

  test('revoking another sign-in keeps the caller; revoking its own ends the session', async ({
    assert,
  }) => {
    await insertUser(kit)
    const { call, signIn, terminated } = mount('session')
    const phone = await signIn('Phone')
    const laptop = await signIn('Laptop')
    const rows = await kit.db.from('account_sessions').orderBy('id')
    const other = await call('DELETE /api/v1/account/sessions/:id', {
      as: phone,
      params: { id: String(rows[1].id) },
    })
    assert.deepEqual(other, { status: 204 })
    assert.deepEqual(terminated, [])
    const rejected = await call('GET /api/v1/account/sessions', { as: laptop })
    assert.equal(rejected.status, 401)

    const own = await call('DELETE /api/v1/account/sessions/:id', {
      as: phone,
      params: { id: String(rows[0].id) },
    })
    assert.deepEqual(own, { status: 204 })
    assert.deepEqual(terminated, ['session'])
    assert.lengthOf(await kit.db.from('account_sessions'), 0)
  })

  test('unknown, foreign and malformed ids answer 404 alike', async ({ assert }) => {
    await insertUser(kit)
    await insertUser(kit, { email: 'other@example.test' })
    const { call, signIn } = mount('session')
    const mine = await signIn()
    await call('POST /api/v1/auth/login', {
      body: { ...credentials, email: 'other@example.test' },
    })
    const theirs = await kit.db.from('account_sessions').whereNot('user_id', mine.userId).first()
    for (const id of [String(theirs.id), '999999', 'abc', '0', '1.5']) {
      const output = await call('DELETE /api/v1/account/sessions/:id', {
        as: mine,
        params: { id },
      })
      assert.equal(output.status, 404, id)
      assert.equal(output.body.errors[0].code, 'E_ACCOUNT_KIT_SESSION_NOT_FOUND')
    }
    assert.lengthOf(await kit.db.from('account_sessions'), 2)
  })

  test('revoke others answers with the count and keeps the caller', async ({ assert }) => {
    await insertUser(kit)
    const { call, signIn, terminated } = mount('session')
    const mine = await signIn()
    await signIn()
    await signIn()
    const output = await call('POST /api/v1/account/sessions/revoke-others', { as: mine })
    assert.deepEqual(output, { status: 200, body: { count: 2 } })
    assert.deepEqual(terminated, [])
    const listed = await call('GET /api/v1/account/sessions', { as: mine })
    assert.equal(listed.status, 200)
  })

  test('a session that cannot be ended after revocation is logged; the revocation stands', async ({
    assert,
  }) => {
    await insertUser(kit)
    const { call, signIn, warnings, failTerminateNext } = mount('session')
    const mine = await signIn()
    const own = await call('GET /api/v1/account/sessions', { as: mine })
    const ownId = own.body.sessions.find(({ current }: any) => current).id
    failTerminateNext()
    const revoked = await call('DELETE /api/v1/account/sessions/:id', {
      as: mine,
      params: { id: String(ownId) },
    })
    assert.deepEqual(revoked, { status: 204 })
    const second = await signIn()
    const everywhere = await call('POST /api/v1/account/sessions/revoke-all', { as: second })
    assert.deepEqual(everywhere, { status: 204 })
    assert.lengthOf(await kit.db.from('account_sessions'), 0)
    const warning = 'Managed account operation needs reconciliation'
    assert.deepEqual(warnings, [
      [{ operation: 'account.sessions.revoke', outcome: 'session_end_failed' }, warning],
      [{ operation: 'account.sessions.revokeAll', outcome: 'session_end_failed' }, warning],
    ])
  })

  test('sign out everywhere ends every sign-in and the caller’s session', async ({ assert }) => {
    await insertUser(kit)
    const { call, signIn, terminated } = mount('session')
    const mine = await signIn()
    const other = await signIn()
    const output = await call('POST /api/v1/account/sessions/revoke-all', { as: mine })
    assert.deepEqual(output, { status: 204 })
    assert.deepEqual(terminated, ['session'])
    assert.lengthOf(await kit.db.from('account_sessions'), 0)
    for (const input of [mine, other]) {
      const listed = await call('GET /api/v1/account/sessions', { as: input })
      assert.equal(listed.status, 401)
    }
  })

  test('a failing observer after a committed revocation still ends the caller’s session', async ({
    assert,
  }) => {
    await insertUser(kit)
    const { call, signIn, terminated } = mount('session', {
      onLifecycleEvent: async (event) => {
        if (event.type.startsWith('sessions.')) throw new Error('observer down')
      },
    })
    const mine = await signIn()
    const own = await kit.db.from('account_sessions').first()
    const revoked = await call('DELETE /api/v1/account/sessions/:id', {
      as: mine,
      params: { id: String(own.id) },
    })
    assert.equal(revoked.status, 202)
    assert.deepEqual(revoked.body, { committed: true })
    assert.deepEqual(terminated, ['session'])

    const again = await signIn()
    await signIn()
    const all = await call('POST /api/v1/account/sessions/revoke-all', { as: again })
    assert.equal(all.status, 202)
    assert.deepEqual(all.body, { committed: true })
    assert.deepEqual(terminated, ['session', 'session'])
    assert.lengthOf(await kit.db.from('account_sessions'), 0)
  })

  test('a failing observer after revoking another sign-in keeps the caller', async ({ assert }) => {
    await insertUser(kit)
    const { call, signIn, terminated } = mount('session', {
      onLifecycleEvent: async (event) => {
        if (event.type === 'sessions.revoked') throw new Error('observer down')
      },
    })
    const mine = await signIn()
    await signIn()
    const [, other] = await kit.db.from('account_sessions').orderBy('id')
    const output = await call('DELETE /api/v1/account/sessions/:id', {
      as: mine,
      params: { id: String(other.id) },
    })
    assert.equal(output.status, 202)
    assert.deepEqual(terminated, [])
  })

  test('logout removes the caller’s sign-in row', async ({ assert }) => {
    await insertUser(kit)
    const { call, signIn } = mount('session')
    const mine = await signIn()
    await signIn()
    assert.deepEqual(await call('POST /api/v1/account/logout', { as: mine }), { status: 204 })
    assert.lengthOf(await kit.db.from('account_sessions'), 1)
    const listed = await call('GET /api/v1/account/sessions', { as: mine })
    assert.equal(listed.status, 401)
  })

  test('session writes require Shield CSRF middleware', async ({ assert }) => {
    await insertUser(kit)
    const { call, signIn } = mount('session')
    const mine = await signIn()
    for (const key of [
      'DELETE /api/v1/account/sessions/:id',
      'POST /api/v1/account/sessions/revoke-others',
      'POST /api/v1/account/sessions/revoke-all',
    ])
      await assert.rejects(
        () => call(key, { as: mine, params: { id: '1' }, csrf: false }),
        /require Shield CSRF middleware/
      )
    assert.lengthOf(await kit.db.from('account_sessions'), 1)
  })

  test('access-token callers manage tokens and are not terminated on revocation', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { call, terminated, established } = mount('access_tokens')
    const login = await call('POST /api/v1/auth/login', {
      body: credentials,
      userAgent: 'Phone/1.0',
    })
    assert.equal(login.status, 200)
    assert.deepEqual(established, [[user.id, ['*'], null, { name: 'Phone/1.0' }]])

    const insert = async (name: string) => {
      const [row] = await kit.db
        .table('auth_access_tokens')
        .insert({
          tokenable_id: user.id,
          name,
          hash: `hash-${name}`,
          created_at: dbTime(kit, DateTime.utc()),
        })
        .returning('id')
      return typeof row === 'object' ? (row as { id: number }).id : (row as number)
    }
    const mine = { userId: user.id, tokenId: await insert('Mine') }
    const other = await insert('Other')
    await insert('Third')
    const listed = await call('GET /api/v1/account/sessions', { as: mine })
    assert.deepEqual(
      listed.body.sessions.map(({ label, current }: any) => [label, current]),
      [
        ['Third', false],
        ['Other', false],
        ['Mine', true],
      ]
    )
    const revoked = await call('DELETE /api/v1/account/sessions/:id', {
      as: mine,
      params: { id: String(other) },
    })
    assert.deepEqual(revoked, { status: 204 })
    const others = await call('POST /api/v1/account/sessions/revoke-others', { as: mine })
    assert.deepEqual(others.body, { count: 1 })
    const all = await call('POST /api/v1/account/sessions/revoke-all', { as: mine })
    assert.deepEqual(all, { status: 204 })
    assert.deepEqual(terminated, [])
    assert.lengthOf(await kit.db.from('auth_access_tokens').where('tokenable_id', user.id), 0)
  })
})
