import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import {
  CapabilityDisabledError,
  InvalidSessionError,
  PostCommitError,
  SessionNotFoundError,
} from '../src/errors.js'
import { revocationOutcome } from '../src/session_revocation.js'
import type {
  AccountKitConfig,
  CredentialChangeContext,
  CurrentAccountInput,
  LifecycleEvent,
  SessionsRevokedContext,
  Trx,
  UserId,
} from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { dbTime } from './helpers/db_time.js'

const later = (days: number) => DateTime.utc().plus({ days })

/** Run `body` with an application table holding one row per sign-in id, dropped afterwards. */
async function withAppRows(
  kit: ReturnType<typeof useTestApp>,
  body: () => Promise<void>
): Promise<void> {
  const schema = kit.db.connection().schema
  await schema.dropTableIfExists('app_session_rows')
  await schema.createTable('app_session_rows', (table) => {
    table.increments('id')
    table.integer('sign_in_id').notNullable()
  })
  try {
    await body()
  } finally {
    await schema.dropTableIfExists('app_session_rows')
  }
}

async function appRows(kit: ReturnType<typeof useTestApp>): Promise<number[]> {
  const rows = await kit.db.from('app_session_rows').select('sign_in_id')
  return rows.map((row) => Number(row.sign_in_id))
}

test.group('sign-in management with sessions', (group) => {
  const kit = useTestApp(group)
  const events: LifecycleEvent[] = []
  const changes: CredentialChangeContext[] = []
  group.each.setup(() => {
    events.length = 0
    changes.length = 0
  })
  const service = (overrides: Partial<AccountKitConfig> = {}) =>
    makeService(kit, {
      enabled: ['sessionManagement'],
      authentication: { strategy: 'session', guard: 'web' },
      minRequestMs: 0,
      onLifecycleEvent: async (event) => void events.push(event),
      onCredentialsChanged: async (_user, context) => void changes.push(context),
      ...overrides,
    })

  async function signIn(
    account: ReturnType<typeof service>['account'],
    email = 'person@example.test',
    sessionLabel?: string
  ): Promise<CurrentAccountInput> {
    let input: CurrentAccountInput | undefined
    await account.authentication.login(
      { email, password: 'password123', clientKey: 'client', sessionLabel },
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

  test('lists live sign-ins newest first and marks the caller', async ({ assert }) => {
    await insertUser(kit)
    const { account } = service()
    const first = await signIn(account, undefined, 'Firefox')
    const second = await signIn(account, undefined, 'Safari')
    await signIn(account, undefined, 'Expired')
    await kit.db
      .from('account_sessions')
      .where('label', 'Expired')
      .update({
        expires_at: dbTime(kit, DateTime.utc().minus({ minutes: 1 })),
      })
    const list = await account.authentication.sessions.list({ current: first })
    assert.deepEqual(
      list.map(({ label, current }) => [label, current]),
      [
        ['Safari', false],
        ['Firefox', true],
      ]
    )
    for (const entry of list) {
      assert.isNumber(entry.id)
      for (const key of ['createdAt', 'lastSeenAt', 'expiresAt'] as const)
        assert.match(entry[key]!, /^\d{4}-\d\d-\d\dT.*Z$/)
    }
    const fromSecond = await account.authentication.sessions.list({ current: second })
    assert.deepEqual(
      fromSecond.map((entry) => entry.current),
      [true, false]
    )
  })

  test('revokes another sign-in, then the caller’s own', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account } = service()
    const mine = await signIn(account)
    const other = await signIn(account)
    const [otherRow, myRow] = await account.authentication.sessions.list({ current: mine })
    assert.deepEqual(
      await account.authentication.sessions.revoke({ current: mine, id: otherRow.id }),
      {
        current: false,
      }
    )
    await assert.rejects(() => account.authentication.current(other), InvalidSessionError)
    await account.authentication.current(mine)
    assert.deepEqual(
      await account.authentication.sessions.revoke({ current: mine, id: String(myRow.id) }),
      { current: true }
    )
    await assert.rejects(() => account.authentication.current(mine), InvalidSessionError)
    assert.deepEqual(
      events.map((event) => [event.type, 'count' in event ? event.count : null]),
      [
        ['sessions.revoked', 1],
        ['sessions.revoked', 1],
      ]
    )
    assert.equal((events[0] as { userId: UserId }).userId, user.id)
    assert.deepEqual(changes, [])
  })

  test('another user’s, unknown and malformed ids look the same and change nothing', async ({
    assert,
  }) => {
    await insertUser(kit)
    await insertUser(kit, { email: 'other@example.test' })
    const { account } = service()
    const mine = await signIn(account)
    const theirs = await signIn(account, 'other@example.test')
    const [theirRow] = await account.authentication.sessions.list({ current: theirs })
    for (const id of [theirRow.id, 999, 0, -1, '1.5', 'abc', null, '01'])
      await assert.rejects(
        () => account.authentication.sessions.revoke({ current: mine, id }),
        SessionNotFoundError
      )
    assert.lengthOf(await kit.db.from('account_sessions'), 2)
    await account.authentication.current(theirs)
    assert.deepEqual(events, [])
  })

  test('revoke others keeps the caller signed in', async ({ assert }) => {
    await insertUser(kit)
    await insertUser(kit, { email: 'other@example.test' })
    const { account } = service()
    const mine = await signIn(account)
    const others = [await signIn(account), await signIn(account)]
    const bystander = await signIn(account, 'other@example.test')
    assert.deepEqual(await account.authentication.sessions.revokeOthers({ current: mine }), {
      count: 2,
    })
    for (const other of others)
      await assert.rejects(() => account.authentication.current(other), InvalidSessionError)
    await account.authentication.current(mine)
    await account.authentication.current(bystander)
    assert.deepEqual(
      events.map((event) => [event.type, 'count' in event ? event.count : null]),
      [['sessions.revoked', 2]]
    )
    assert.deepEqual(await account.authentication.sessions.revokeOthers({ current: mine }), {
      count: 0,
    })
  })

  test('sign out everywhere is a credential change with its hooks', async ({ assert }) => {
    const user = await insertUser(kit)
    const inTransaction: CredentialChangeContext[] = []
    const { account } = service({
      onCredentialsChanged: undefined,
      onCredentialsChangedTransaction: async (_user, context) => void inTransaction.push(context),
    })
    const mine = await signIn(account)
    const other = await signIn(account)
    const before = await kit.db.from('users').where('id', user.id).first()
    await account.authentication.sessions.revokeAll({ current: mine })
    const after = await kit.db.from('users').where('id', user.id).first()
    assert.notEqual(after.credentials_changed_at, before.credentials_changed_at)
    assert.lengthOf(await kit.db.from('account_sessions'), 0)
    for (const input of [mine, other])
      await assert.rejects(() => account.authentication.current(input), InvalidSessionError)
    assert.deepEqual(
      inTransaction.map((context) => [context.operation, context.userId]),
      [['sign_out_everywhere', user.id]]
    )
    assert.deepEqual(
      events.map((event) => event.type),
      ['sessions.revoked_all']
    )
    assert.equal((events[0] as { operationId: string }).operationId, inTransaction[0].operationId)
  })

  /** A hook that deletes the application's rows for the revoked ids and records each call. */
  function revocationHook(seen: Array<{ userId: UserId; context: SessionsRevokedContext }>) {
    return async (user: { id: UserId }, context: SessionsRevokedContext, trx: Trx) => {
      seen.push({ userId: user.id, context })
      await trx
        .from('app_session_rows')
        .whereIn('sign_in_id', [...context.signInIds])
        .delete()
    }
  }

  test('revoke runs onSessionsRevokedTransaction in its transaction', async ({ assert }) => {
    await withAppRows(kit, async () => {
      const user = await insertUser(kit)
      const seen: Array<{ userId: UserId; context: SessionsRevokedContext }> = []
      const { account } = service({ onSessionsRevokedTransaction: revocationHook(seen) })
      const mine = await signIn(account)
      await signIn(account)
      const [otherRow, myRow] = await account.authentication.sessions.list({ current: mine })
      await kit.db
        .table('app_session_rows')
        .insert([{ sign_in_id: otherRow.id }, { sign_in_id: myRow.id }])
      await account.authentication.sessions.revoke({ current: mine, id: otherRow.id })
      assert.lengthOf(seen, 1)
      assert.equal(seen[0].userId, user.id)
      assert.equal(seen[0].context.userId, user.id)
      assert.deepEqual(seen[0].context.signInIds, [otherRow.id])
      assert.isTrue(Object.isFrozen(seen[0].context.signInIds))
      assert.lengthOf(await kit.db.from('account_sessions').where('id', otherRow.id), 0)
      assert.deepEqual(await appRows(kit), [myRow.id])
      assert.equal((events[0] as { operationId: string }).operationId, seen[0].context.operationId)
    })
  })

  test('revokeOthers reports exactly the other sign-ins', async ({ assert }) => {
    const seen: Array<{ userId: UserId; context: SessionsRevokedContext }> = []
    await withAppRows(kit, async () => {
      await insertUser(kit)
      await insertUser(kit, { email: 'other@example.test' })
      const { account } = service({ onSessionsRevokedTransaction: revocationHook(seen) })
      const mine = await signIn(account)
      await signIn(account)
      await signIn(account)
      await signIn(account, 'other@example.test')
      const list = await account.authentication.sessions.list({ current: mine })
      const ids = list.filter((row) => !row.current).map((row) => row.id)
      assert.deepEqual(await account.authentication.sessions.revokeOthers({ current: mine }), {
        count: 2,
      })
      assert.lengthOf(seen, 1)
      assert.deepEqual([...seen[0].context.signInIds].sort(), [...ids].sort())
      const event = events[0] as { count: number; operationId: string }
      assert.equal(event.count, seen[0].context.signInIds.length)
      assert.equal(event.operationId, seen[0].context.operationId)
    })
  })

  test('revokeOthers with nothing to revoke skips the hook', async ({ assert }) => {
    let calls = 0
    await insertUser(kit)
    const { account } = service({ onSessionsRevokedTransaction: async () => void calls++ })
    const mine = await signIn(account)
    assert.deepEqual(await account.authentication.sessions.revokeOthers({ current: mine }), {
      count: 0,
    })
    assert.equal(calls, 0)
    assert.deepEqual(
      events.map((event) => [event.type, 'count' in event ? event.count : null]),
      [['sessions.revoked', 0]]
    )
  })

  test('a throwing onSessionsRevokedTransaction keeps the sign-in', async ({ assert }) => {
    await withAppRows(kit, async () => {
      await insertUser(kit)
      const failure = new Error('keep')
      const { account } = service({
        onSessionsRevokedTransaction: async (_user, context, trx) => {
          await trx
            .from('app_session_rows')
            .whereIn('sign_in_id', [...context.signInIds])
            .delete()
          throw failure
        },
      })
      const mine = await signIn(account)
      const other = await signIn(account)
      const [otherRow] = await account.authentication.sessions.list({ current: mine })
      await kit.db.table('app_session_rows').insert({ sign_in_id: otherRow.id })
      try {
        await account.authentication.sessions.revoke({ current: mine, id: otherRow.id })
        assert.fail('expected the hook failure')
      } catch (error) {
        assert.strictEqual(error, failure)
      }
      await account.authentication.current(other)
      assert.deepEqual(await appRows(kit), [otherRow.id])
      assert.deepEqual(events, [])
    })
  })

  test('sign out everywhere does not run onSessionsRevokedTransaction', async ({ assert }) => {
    await insertUser(kit)
    let revokedCalls = 0
    let changedCalls = 0
    const { account } = service({
      onCredentialsChanged: undefined,
      onCredentialsChangedTransaction: async () => void changedCalls++,
      onSessionsRevokedTransaction: async () => void revokedCalls++,
    })
    const mine = await signIn(account)
    await signIn(account)
    await account.authentication.sessions.revokeAll({ current: mine })
    assert.equal(revokedCalls, 0)
    assert.equal(changedCalls, 1)
  })

  test('sign out everywhere runs the post-commit credential hook', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account } = service()
    await account.authentication.sessions.revokeAll({ current: await signIn(account) })
    assert.deepEqual(
      changes.map((context) => [context.operation, context.userId]),
      [['sign_out_everywhere', user.id]]
    )
  })

  test('a revoked caller cannot manage sign-ins', async ({ assert }) => {
    await insertUser(kit)
    const { account } = service()
    const mine = await signIn(account)
    const other = await signIn(account)
    await account.authentication.sessions.revokeOthers({ current: other })
    for (const call of [
      () => account.authentication.sessions.list({ current: mine }),
      () => account.authentication.sessions.revokeOthers({ current: mine }),
      () => account.authentication.sessions.revokeAll({ current: mine }),
      () => account.authentication.sessions.revoke({ current: mine, id: 1 }),
    ])
      await assert.rejects(call, InvalidSessionError)
    await account.authentication.current(other)
  })

  test('a failing observer still reports which sign-in was revoked', async ({ assert }) => {
    await insertUser(kit)
    const { account } = service({
      onLifecycleEvent: async () => {
        throw new Error('observer down')
      },
    })
    const mine = await signIn(account)
    const [row] = await account.authentication.sessions.list({ current: mine })
    const error = await account.authentication.sessions
      .revoke({ current: mine, id: row.id })
      .catch((caught: unknown) => caught)
    assert.instanceOf(error, PostCommitError)
    assert.deepEqual(revocationOutcome(error), { current: true })
    assert.lengthOf(await kit.db.from('account_sessions'), 0)
    assert.isUndefined(revocationOutcome(new PostCommitError('unrelated')))
  })

  test('every operation needs the capability', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { strategy: 'session', guard: 'web' },
      minRequestMs: 0,
    })
    const current = { userId: user.id, revision: null }
    for (const call of [
      () => account.authentication.sessions.list({ current }),
      () => account.authentication.sessions.revoke({ current, id: 1 }),
      () => account.authentication.sessions.revokeOthers({ current }),
      () => account.authentication.sessions.revokeAll({ current }),
    ])
      await assert.rejects(call, CapabilityDisabledError)
  })
})

test.group('sign-in management with access tokens', (group) => {
  const kit = useTestApp(group)
  const service = () =>
    makeService(kit, {
      enabled: ['sessionManagement'],
      authentication: { strategy: 'access_tokens', guard: 'api' },
      minRequestMs: 0,
    })

  async function token(userId: UserId, name: string | null, expiresAt: DateTime | null = null) {
    const [row] = await kit.db
      .table('auth_access_tokens')
      .insert({
        tokenable_id: userId,
        name,
        hash: `hash-${name}`,
        created_at: dbTime(kit, DateTime.utc()),
        last_used_at: null,
        expires_at: expiresAt && dbTime(kit, expiresAt),
      })
      .returning('id')
    const id = typeof row === 'object' ? (row as { id: number }).id : (row as number)
    return { userId, tokenId: id }
  }

  test('lists unexpired tokens, marks the caller and revokes', async ({ assert }) => {
    const user = await insertUser(kit)
    const other = await insertUser(kit, { email: 'other@example.test' })
    const { account } = service()
    const mine = await token(user.id, 'Phone', later(1))
    const laptop = await token(user.id, 'Laptop')
    await token(user.id, 'Old', DateTime.utc().minus({ days: 1 }))
    const theirs = await token(other.id, 'Theirs')
    const list = await account.authentication.sessions.list({ current: mine })
    assert.deepEqual(
      list.map(({ id, label, current, lastSeenAt }) => [id, label, current, lastSeenAt]),
      [
        [laptop.tokenId, 'Laptop', false, null],
        [mine.tokenId, 'Phone', true, null],
      ]
    )
    assert.isNull(list[0].expiresAt)
    await assert.rejects(
      () => account.authentication.sessions.revoke({ current: mine, id: theirs.tokenId }),
      SessionNotFoundError
    )
    assert.deepEqual(
      await account.authentication.sessions.revoke({ current: mine, id: laptop.tokenId }),
      { current: false }
    )
    await assert.rejects(() => account.authentication.current(laptop), InvalidSessionError)
    assert.deepEqual(
      await account.authentication.sessions.revoke({ current: mine, id: mine.tokenId }),
      { current: true }
    )
    await assert.rejects(() => account.authentication.current(mine), InvalidSessionError)
    await account.authentication.current(theirs)
  })

  test('revoke others and sign out everywhere delete tokens', async ({ assert }) => {
    const user = await insertUser(kit)
    const other = await insertUser(kit, { email: 'other@example.test' })
    const { account } = service()
    const mine = await token(user.id, 'Phone')
    await token(user.id, 'Laptop')
    await token(user.id, 'Tablet')
    const theirs = await token(other.id, 'Theirs')
    assert.deepEqual(await account.authentication.sessions.revokeOthers({ current: mine }), {
      count: 2,
    })
    await account.authentication.current(mine)
    await account.authentication.sessions.revokeAll({ current: mine })
    assert.lengthOf(await kit.db.from('auth_access_tokens').where('tokenable_id', user.id), 0)
    await account.authentication.current(theirs)
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isNotNull(row.credentials_changed_at)
  })

  test('onSessionsRevokedTransaction receives token row ids', async ({ assert }) => {
    const user = await insertUser(kit)
    const seen: SessionsRevokedContext[] = []
    const { account } = makeService(kit, {
      enabled: ['sessionManagement'],
      authentication: { strategy: 'access_tokens', guard: 'api' },
      minRequestMs: 0,
      onSessionsRevokedTransaction: async (_user, context) => void seen.push(context),
    })
    const mine = await token(user.id, 'Phone')
    const laptop = await token(user.id, 'Laptop')
    const tablet = await token(user.id, 'Tablet')
    const watch = await token(user.id, 'Watch')
    await account.authentication.sessions.revoke({ current: mine, id: laptop.tokenId })
    assert.deepEqual(await account.authentication.sessions.revokeOthers({ current: mine }), {
      count: 2,
    })
    assert.deepEqual(
      seen.map((context) => [...context.signInIds].sort((a, b) => a - b)),
      [[Number(laptop.tokenId)], [Number(tablet.tokenId), Number(watch.tokenId)]]
    )
  })

  test('token login passes the sign-in label as the token name', async ({ assert }) => {
    await insertUser(kit)
    const { account } = service()
    const calls: unknown[][] = []
    const guard = {
      strategy: 'access_tokens' as const,
      name: 'api',
      establish: async (...args: unknown[]) => {
        calls.push(args)
        return 'token'
      },
      terminate: async () => {},
    }
    const credentials = { email: 'person@example.test', password: 'password123', clientKey: 'c' }
    await account.authentication.login({ ...credentials, sessionLabel: 'Mozilla/5.0' }, guard)
    await account.authentication.login(credentials, guard)
    assert.deepEqual(
      calls.map((args) => args.slice(1)),
      [
        [['*'], null, { name: 'Mozilla/5.0' }],
        [['*'], null],
      ]
    )
  })
})
