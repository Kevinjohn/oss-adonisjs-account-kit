/* eslint-disable @unicorn/no-await-expression-member -- Keep each assertion next to the operation it inspects. */

import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { registerManagedRoutes } from '../src/http/managed.js'
import { InvalidSessionError } from '../src/errors.js'
import type { AccountKitConfig, CurrentAccountInput, UserId } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { dbTime } from './helpers/db_time.js'
import { insertUser, makeService, tokenFrom } from './helpers/fakes.js'
import { fakeManagedHttp, stubGuard } from './helpers/managed_http_fakes.js'

type Validator = { validate(data: unknown): Promise<unknown> }

const change = { currentPassword: 'password123', newPassword: 'newPassword123' }

test.group('password change keeps the current session', (group) => {
  const kit = useTestApp(group)

  const service = (overrides: Partial<AccountKitConfig> = {}) =>
    makeService(kit, {
      enabled: [
        'sessionManagement',
        'emailVerification',
        'emailPasswordManagement',
        'passwordReset',
      ],
      authentication: { strategy: 'session', guard: 'web' },
      minRequestMs: 0,
      ...overrides,
    })

  async function signIn(account: ReturnType<typeof service>['account'], password = 'password123') {
    let input: CurrentAccountInput | undefined
    await account.authentication.login(
      { email: 'person@example.test', password, clientKey: 'client' },
      {
        strategy: 'session',
        name: 'web',
        establish: async (userId: UserId, revision: string | null, handle?: string) => {
          input = { userId, revision, sessionHandle: handle }
        },
        terminate: async () => {},
      }
    )
    return input!
  }

  test('keeps the initiating session with the new revision and ends every other', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = service()
    const mine = await signIn(account)
    const other = await signIn(account)
    const { revision } = await account.emailPasswordManagement.changePassword({
      actorId: user.id,
      ...change,
      keepCurrent: { sessionHandle: mine.sessionHandle },
    })
    assert.isString(revision)
    assert.notEqual(revision, mine.revision)
    const kept = { ...mine, revision }
    assert.equal((await account.authentication.current(kept)).id, user.id)
    await assert.rejects(() => account.authentication.current(mine), InvalidSessionError)
    await assert.rejects(
      () => account.authentication.current({ ...other, revision }),
      InvalidSessionError
    )
    assert.lengthOf(await account.authentication.sessions.list({ current: kept }), 1)
    assert.lengthOf(await kit.db.from('account_sessions'), 1)
  })

  test('without keepCurrent, or with a stale handle, every session ends', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account } = service()
    const mine = await signIn(account)
    const { revision } = await account.emailPasswordManagement.changePassword({
      actorId: user.id,
      ...change,
    })
    assert.lengthOf(await kit.db.from('account_sessions'), 0)
    await assert.rejects(
      () => account.authentication.current({ ...mine, revision }),
      InvalidSessionError
    )

    await signIn(account, 'newPassword123')
    await account.emailPasswordManagement.changePassword({
      actorId: user.id,
      currentPassword: 'newPassword123',
      newPassword: 'thirdPassword123',
      keepCurrent: { sessionHandle: 'x'.repeat(43) },
    })
    assert.lengthOf(await kit.db.from('account_sessions'), 0)
  })

  test('password reset still ends every session', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account, recorder } = service()
    await signIn(account)
    await account.passwordReset.request({ email: user.email, clientKey: 'client' })
    const sent = recorder.calls.find((call) => call.method === 'passwordResetProvision')
    if (!sent) throw new Error('Expected a reset link')
    await account.passwordReset.reset({
      token: tokenFrom(sent.args[1]),
      password: 'newPassword123',
    })
    assert.lengthOf(await kit.db.from('account_sessions'), 0)
  })
})

test.group('password change keeps the current token', (group) => {
  const kit = useTestApp(group)

  async function token(userId: UserId, name: string) {
    const [row] = await kit.db
      .table('auth_access_tokens')
      .insert({
        tokenable_id: userId,
        name,
        hash: `hash-${name}`,
        created_at: dbTime(kit, DateTime.utc()),
        last_used_at: null,
        expires_at: null,
      })
      .returning('id')
    const id = typeof row === 'object' ? (row as { id: number }).id : (row as number)
    return { userId, tokenId: id }
  }

  test('keeps the current token and deletes every other; without it deletes all', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const other = await insertUser(kit, { email: 'other@example.test' })
    const { account } = makeService(kit, {
      enabled: ['sessionManagement', 'emailVerification', 'emailPasswordManagement'],
      authentication: { strategy: 'access_tokens', guard: 'api' },
      minRequestMs: 0,
    })
    const mine = await token(user.id, 'Phone')
    await token(user.id, 'Laptop')
    await token(other.id, 'Theirs')
    await account.emailPasswordManagement.changePassword({
      actorId: user.id,
      ...change,
      keepCurrent: { tokenId: mine.tokenId },
    })
    const left = await kit.db.from('auth_access_tokens').where('tokenable_id', user.id)
    assert.deepEqual(
      left.map((row) => String(row.id)),
      [String(mine.tokenId)]
    )
    assert.equal((await account.authentication.current(mine)).id, user.id)
    assert.lengthOf(await kit.db.from('auth_access_tokens').where('tokenable_id', other.id), 1)

    await account.emailPasswordManagement.changePassword({
      actorId: user.id,
      currentPassword: 'newPassword123',
      newPassword: 'thirdPassword123',
    })
    assert.lengthOf(await kit.db.from('auth_access_tokens').where('tokenable_id', user.id), 0)
  })
})

test.group('managed password change keeps the caller signed in', (group) => {
  const kit = useTestApp(group)

  function mount(strategy: 'session' | 'access_tokens') {
    const service = makeService(kit, {
      enabled: ['sessionManagement', 'emailVerification', 'emailPasswordManagement'],
      authentication: { guard: strategy === 'session' ? 'web' : 'api', strategy },
      minRequestMs: 0,
    })
    const issued: CurrentAccountInput[] = []
    let caller: CurrentAccountInput | undefined
    const guard = stubGuard<string>({
      strategy,
      forRequest: () =>
        ({
          strategy,
          name: strategy === 'session' ? 'web' : 'api',
          establish: async (userId: UserId, ...rest: unknown[]) => {
            issued.push({
              userId,
              revision: rest[0] as string | null,
              sessionHandle: rest[1] as string | undefined,
            })
            return `credential:${userId}`
          },
          terminate: async () => {},
          // The cookie session: the caller's next request carries the stored revision.
          refresh: async (revision: string | null) => {
            caller = { ...caller!, revision }
          },
        }) as never,
      current: async () => caller!,
      publicCredential: (credential: string) => `public:${credential}`,
    })
    const { router, routes, context } = fakeManagedHttp()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => service.account,
      guard,
      enabled: [
        'authentication',
        'sessionManagement',
        'emailVerification',
        'emailPasswordManagement',
      ],
    })
    const call = async (key: string, body: Record<string, unknown> = {}) => {
      const ctx = context({})
      Object.assign(ctx.request, {
        validateUsing: (validator: Validator) => validator.validate(body),
        header: () => undefined,
        ...(strategy === 'session' ? { csrfToken: 'csrf' } : {}),
      })
      return (await routes.get(key)!(ctx)) as { status: number; body?: any }
    }
    const as = (input: CurrentAccountInput) => {
      caller = input
    }
    const current = () => caller!
    return { call, as, current, issued }
  }

  test('session: the same session is still signed in on the next request', async ({ assert }) => {
    await insertUser(kit)
    const { call, as, current, issued } = mount('session')
    await call('POST /api/v1/auth/login', { email: 'person@example.test', password: 'password123' })
    await call('POST /api/v1/auth/login', { email: 'person@example.test', password: 'password123' })
    const [mine, other] = issued
    as(mine)
    const changed = await call('POST /api/v1/account/password', {
      ...change,
      newPasswordConfirmation: change.newPassword,
    })
    assert.deepEqual(changed, { status: 200, body: { changed: true } })
    assert.notEqual(current().revision, mine.revision)
    assert.equal(current().sessionHandle, mine.sessionHandle)
    assert.equal((await call('GET /api/v1/account/sessions')).status, 200)
    as({ ...other, revision: current().revision })
    assert.equal((await call('GET /api/v1/account/sessions')).status, 401)
    assert.lengthOf(await kit.db.from('account_sessions'), 1)
  })

  test('access tokens: the calling token survives and the others are deleted', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { call, as } = mount('access_tokens')
    const ids = []
    for (const name of ['Phone', 'Laptop']) {
      const [row] = await kit.db
        .table('auth_access_tokens')
        .insert({
          tokenable_id: user.id,
          name,
          hash: `hash-${name}`,
          created_at: dbTime(kit, DateTime.utc()),
          last_used_at: null,
          expires_at: null,
        })
        .returning('id')
      ids.push(typeof row === 'object' ? (row as { id: number }).id : (row as number))
    }
    as({ userId: user.id, tokenId: ids[0] })
    assert.equal(
      (
        await call('POST /api/v1/account/password', {
          ...change,
          newPasswordConfirmation: change.newPassword,
        })
      ).status,
      200
    )
    assert.equal((await call('GET /api/v1/account/sessions')).status, 200)
    as({ userId: user.id, tokenId: ids[1] })
    assert.equal((await call('GET /api/v1/account/sessions')).status, 401)
  })
})
