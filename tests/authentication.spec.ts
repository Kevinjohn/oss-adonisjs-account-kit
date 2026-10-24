import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { InvalidSessionError } from '../src/errors.js'
import { readIsoTimestamp } from '../src/timestamps.js'
import type { CurrentAccountInput, UserId } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { dbTime } from './helpers/db_time.js'
import { locksRows } from './helpers/dialect.js'
import { insertUser, makeService } from './helpers/fakes.js'
import {
  assertUserLockIsHeld,
  createBarrier,
  startWithBackendId,
  waitForBlockedBy,
  waitForDatabaseLockWait,
} from './helpers/lock_coordination.js'

const sessionGuard = (events: string[] = []) => ({
  strategy: 'session' as const,
  name: 'web',
  establish: async (_id: number | string, stamp: string | null) => {
    events.push(`establish:${stamp}`)
    return stamp
  },
  terminate: async () => {
    events.push('terminate')
  },
})

test.group('authentication contract', (group) => {
  const kit = useTestApp(group)

  test('rejects invalid credentials with one public error and counts failures only', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { strategy: 'access_tokens', guard: 'api' },
    })
    const issued: string[] = []
    const guard = {
      strategy: 'access_tokens' as const,
      name: 'api',
      establish: async () => {
        issued.push('token')
        return 'token'
      },
      terminate: async () => {},
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      await assert.rejects(
        () =>
          account.authentication.login(
            { email: user.email, password: 'wrong', clientKey: 'ip-1' },
            guard
          ),
        'Invalid email or password'
      )
    }
    await assert.rejects(
      () =>
        account.authentication.login(
          { email: user.email, password: 'password123', clientKey: 'ip-1' },
          guard
        ),
      'Too many requests'
    )
    assert.deepEqual(issued, [])
    const result = await account.authentication.login(
      { email: user.email, password: 'password123', clientKey: 'ip-2' },
      guard
    )
    assert.equal(result.credential, 'token')
    assert.deepEqual(result.account, {
      id: user.id,
      email: user.email,
      unverifiedEmail: null,
      hasPassword: true,
      active: true,
    })
  })

  test('every invalid-credential failure waits out the request floor', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { strategy: 'access_tokens', guard: 'api' },
      minRequestMs: 150,
    })
    const guard = {
      strategy: 'access_tokens' as const,
      name: 'api',
      establish: async () => 'token',
      terminate: async () => {},
    }
    for (const [index, email] of ['missing@example.test', user.email].entries()) {
      const started = performance.now()
      await assert.rejects(
        () =>
          account.authentication.login(
            { email, password: 'wrong', clientKey: `floor-${index}` },
            guard
          ),
        'Invalid email or password'
      )
      assert.isAtLeast(performance.now() - started, 150)
    }
  })

  test('allows a limited inactive login but denies protected access', async ({ assert }) => {
    const user = await insertUser(kit, { verified: false })
    const { account } = makeService(kit, {
      authentication: { strategy: 'session', guard: 'web' },
    })
    let revision: string | null = null
    const guard = {
      strategy: 'session' as const,
      name: 'web',
      establish: async (_id: number | string, stamp: string | null) => {
        revision = stamp
        return undefined
      },
      terminate: async () => {},
    }
    const result = await account.authentication.login(
      { email: user.email, password: 'password123', clientKey: 'ip-1' },
      guard
    )
    assert.isFalse(result.account.active)
    assert.deepEqual(
      await account.authentication.current({ userId: user.id, revision }),
      result.account
    )
    await assert.rejects(
      () => account.authentication.requireActive({ userId: user.id, revision }),
      'Email verification is required'
    )
  })

  test('rejects an adapter for a different named guard before password verification', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { strategy: 'session', guard: 'web' },
    })
    await assert.rejects(
      () =>
        account.authentication.login(
          { email: user.email, password: 'password123', clientKey: 'ip-1' },
          { ...sessionGuard(), name: 'other' }
        ),
      'account_kit: expected web session guard'
    )
  })

  test('passes configured token lifetime and abilities to the selected guard', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: {
        strategy: 'access_tokens',
        guard: 'api',
        tokenAbilities: ['profile:read'],
        tokenExpiresIn: '1d',
      },
    })
    let passed: unknown[] = []
    await account.authentication.login(
      { email: user.email, password: 'password123', clientKey: 'ip-1' },
      {
        strategy: 'access_tokens',
        name: 'api',
        establish: async (_id, abilities, expiresIn) => {
          passed = [abilities, expiresIn]
          return 'opaque'
        },
        terminate: async () => {},
      }
    )
    assert.deepEqual(passed, [['profile:read'], '1d'])
  })

  test('a session with a missing or old stamp never captures a fresh revision', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { strategy: 'session', guard: 'web' },
    })
    await assert.rejects(
      () => account.authentication.current({ userId: user.id }),
      'Invalid session'
    )
    await account.authentication.changeRestriction({ userId: user.id, change: async () => {} })
    await assert.rejects(
      () => account.authentication.current({ userId: user.id, revision: null }),
      'Invalid session'
    )
  })

  test('logout calls only the selected current guard and has an idempotent service result', async ({
    assert,
  }) => {
    await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { strategy: 'access_tokens', guard: 'api' },
    })
    let calls = 0
    const guard = {
      terminate: async () => {
        calls++
      },
    }
    await account.authentication.logout(guard)
    await account.authentication.logout(guard)
    assert.equal(calls, 2)
  })
})

test.group('authentication.withCurrent', (group) => {
  const kit = useTestApp(group)
  const service = (strategy: 'session' | 'access_tokens' = 'session') =>
    makeService(kit, {
      enabled: ['sessionManagement'],
      authentication:
        strategy === 'session'
          ? { strategy: 'session', guard: 'web' }
          : { strategy: 'access_tokens', guard: 'api' },
      minRequestMs: 0,
    })

  async function signIn(account: ReturnType<typeof service>['account']) {
    let input: CurrentAccountInput | undefined
    await account.authentication.login(
      { email: 'person@example.test', password: 'password123', clientKey: 'client' },
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

  /** Run `body` with an application table, dropped afterwards. */
  async function withAppTable(body: () => Promise<void>) {
    const schema = kit.db.connection().schema
    await schema.dropTableIfExists('app_writes')
    await schema.createTable('app_writes', (table) => {
      table.increments('id')
      table.string('note').notNullable()
    })
    try {
      await body()
    } finally {
      await schema.dropTableIfExists('app_writes')
    }
  }

  test('passes current’s account and the caller’s sign-in id to run', async ({ assert }) => {
    await insertUser(kit)
    const { account } = service()
    const input = await signIn(account)
    const [row] = await account.authentication.sessions.list({ current: input })
    const expected = await account.authentication.current(input)
    const result = await account.authentication.withCurrent(input, async (context) => {
      assert.deepEqual(context.account, expected)
      assert.equal(context.signInId, row.id)
      assert.isTrue(row.current)
      return 'done'
    })
    assert.equal(result, 'done')
  })

  test('has no sign-in id under access tokens', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account } = service('access_tokens')
    const [inserted] = await kit.db
      .table('auth_access_tokens')
      .insert({ tokenable_id: user.id, name: 'Phone', hash: 'hash', created_at: new Date() })
      .returning('id')
    const tokenId = typeof inserted === 'object' ? (inserted as { id: number }).id : inserted
    let signInId: number | undefined = -1
    await account.authentication.withCurrent({ userId: user.id, tokenId }, async (context) => {
      signInId = context.signInId
    })
    assert.isUndefined(signInId)
  })

  test('commits writes made through trx with the call', async ({ assert }) => {
    await withAppTable(async () => {
      await insertUser(kit)
      const { account } = service()
      const input = await signIn(account)
      await account.authentication.withCurrent(input, ({ trx }) =>
        trx.table('app_writes').insert({ note: 'kept' })
      )
      assert.lengthOf(await kit.db.from('app_writes').where('note', 'kept'), 1)
    })
  })

  test('rolls writes back and rethrows when run throws', async ({ assert }) => {
    await withAppTable(async () => {
      await insertUser(kit)
      const { account } = service()
      const input = await signIn(account)
      const failure = new Error('abort')
      try {
        await account.authentication.withCurrent(input, async ({ trx }) => {
          await trx.table('app_writes').insert({ note: 'dropped' })
          throw failure
        })
        assert.fail('expected the run failure')
      } catch (error) {
        assert.strictEqual(error, failure)
      }
      assert.lengthOf(await kit.db.from('app_writes'), 0)
    })
  })

  test('run acts on the Kit’s own transaction', async ({ assert }) => {
    await insertUser(kit)
    const { account } = service()
    const input = await signIn(account)
    const stale = DateTime.utc().minus({ minutes: 6 })
    await kit.db
      .from('account_sessions')
      .where('user_id', input.userId)
      .update({ last_seen_at: dbTime(kit, stale) })
    await account.authentication.withCurrent(input, async ({ trx, signInId }) => {
      // The touch is not committed yet; only the Kit's own transaction can see it.
      const row = await trx.from('account_sessions').where('id', signInId!).first()
      assert.isAbove(Date.parse(readIsoTimestamp(row.last_seen_at)!), stale.toMillis() + 60_000)
      await trx.from('account_sessions').where('id', signInId!).delete()
    })
    await assert.rejects(() => account.authentication.current(input), InvalidSessionError)
  }).timeout(5_000)

  test('touches the session', async ({ assert }) => {
    await insertUser(kit)
    const { account } = service()
    const input = await signIn(account)
    const stale = DateTime.utc().minus({ minutes: 6 })
    await kit.db
      .from('account_sessions')
      .where('user_id', input.userId)
      .update({ last_seen_at: dbTime(kit, stale) })
    await account.authentication.withCurrent(input, async () => {})
    const row = await kit.db.from('account_sessions').where('user_id', input.userId).first()
    assert.isAbove(Date.parse(readIsoTimestamp(row.last_seen_at)!), stale.toMillis() + 60_000)
  })

  test('rejects a stale credential revision without running', async ({ assert }) => {
    await insertUser(kit)
    const { account } = service()
    const input = await signIn(account)
    await kit.db
      .from('users')
      .where('id', input.userId)
      .update({ credentials_changed_at: dbTime(kit, DateTime.utc().plus({ minutes: 1 })) })
    let ran = false
    await assert.rejects(
      () => account.authentication.withCurrent(input, async () => void (ran = true)),
      InvalidSessionError
    )
    assert.isFalse(ran)
  })

  test('holds the account row lock while run executes', async ({ assert }) => {
    if (!locksRows) return
    await insertUser(kit)
    const { account } = service()
    const input = await signIn(account)
    await account.authentication.withCurrent(input, async ({ account: current }) => {
      await assertUserLockIsHeld(kit, assert, current.id)
    })
  }).timeout(10_000)

  test('a revocation waits for run and then invalidates the sign-in', async ({ assert }) => {
    if (!locksRows) return
    await insertUser(kit)
    const { account } = service()
    const input = await signIn(account)
    const [row] = await account.authentication.sessions.list({ current: input })
    const inside = createBarrier('withCurrent')
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    const order: string[] = []
    const tracked = startWithBackendId(kit, () =>
      account.authentication.withCurrent(input, async () => {
        inside.signal()
        await released
        order.push('run')
      })
    )
    inside.observe(tracked.operation)
    const writer = tracked.operation
    let revoke: Promise<void> | undefined
    try {
      await inside.promise
      const revoker = startWithBackendId(kit, () =>
        account.authentication.sessions.revoke({ current: input, id: row.id })
      )
      revoke = revoker.operation.then(() => void order.push('revoke'))
      await waitForDatabaseLockWait(kit, assert, await revoker.backendId, await tracked.backendId)
    } finally {
      release()
      await Promise.all([writer.catch(() => {}), revoke?.catch(() => {})])
    }
    await Promise.all([writer, revoke])
    assert.deepEqual(order, ['run', 'revoke'])
    await assert.rejects(() => account.authentication.current(input), InvalidSessionError)
  }).timeout(10_000)

  test('a logout waits for run and then invalidates the sign-in', async ({ assert }) => {
    if (!locksRows) return
    await insertUser(kit)
    const { account } = service()
    const input = await signIn(account)
    const inside = createBarrier('withCurrent')
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    const order: string[] = []
    const tracked = startWithBackendId(kit, () =>
      account.authentication.withCurrent(input, async () => {
        inside.signal()
        await released
        order.push('run')
      })
    )
    inside.observe(tracked.operation)
    const writer = tracked.operation
    let logout: Promise<void> | undefined
    try {
      await inside.promise
      // The session was just created, so `current` did not touch (and lock) it.
      logout = account.authentication
        .logout({ terminate: async () => {} }, undefined, input)
        .then(() => void order.push('logout'))
      await waitForBlockedBy(kit, assert, await tracked.backendId)
    } finally {
      release()
      await Promise.all([writer.catch(() => {}), logout?.catch(() => {})])
    }
    await Promise.all([writer, logout])
    assert.deepEqual(order, ['run', 'logout'])
    await assert.rejects(() => account.authentication.current(input), InvalidSessionError)
  }).timeout(10_000)

  test('rejects a sign-in deleted after current read it', async ({ assert }) => {
    if (!locksRows) return
    await insertUser(kit)
    let input: CurrentAccountInput | undefined
    const { account } = makeService(kit, {
      enabled: ['sessionManagement'],
      authentication: {
        strategy: 'session',
        guard: 'web',
        // Runs after the session row is read and before it is locked; deletes it on another
        // connection, as a logout that skips the account lock would.
        canAccess: async () => {
          if (input) await kit.db.from('account_sessions').where('user_id', input.userId).delete()
          return true
        },
      },
      minRequestMs: 0,
    })
    const signedIn = await signIn(account)
    input = signedIn
    let ran = false
    await assert.rejects(
      () => account.authentication.withCurrent(signedIn, async () => void (ran = true)),
      InvalidSessionError
    )
    assert.isFalse(ran)
  }).timeout(10_000)
})
