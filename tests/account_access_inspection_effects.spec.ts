import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { AccountKit } from '../src/account_kit.js'
import { AccountAccessDeniedError, PostCommitError } from '../src/errors.js'
import type { AccountKitConfig } from '../src/types.js'
import { useTestApp, bootTestApp } from './helpers/app.js'
import { failure } from './helpers/failure.js'
import { insertUser, makeService, makeUsersAdapter } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'
import { dbTime } from './helpers/db_time.js'
import { testEngine } from './helpers/dialect.js'
import { faultAfterCommit } from './helpers/fault_after_commit.js'

test.group('account access inspection side effects and dependency failures', (group) => {
  const kit = useTestApp(group)
  const sessionAuthentication = { strategy: 'session' as const, guard: 'web' }
  const accessTokenAuthentication = { strategy: 'access_tokens' as const, guard: 'api' }
  const baseEnabled = [
    'passwordReset',
    'emailVerification',
    'invitations',
    'emailPasswordManagement',
  ] as const

  for (const strategy of ['session', 'access_tokens'] as const) {
    for (const hookType of ['transaction', 'after-commit'] as const) {
      test(`INS-06 ${strategy} inspection is read-only with ${hookType} credential hooks`, async ({
        assert,
      }) => {
        const user = await insertUser(kit)
        const credentialHookCalls = { count: 0 }
        const lifecycleHookCalls = { count: 0 }
        const credentialHook =
          hookType === 'transaction'
            ? {
                onCredentialsChangedTransaction: async () => {
                  credentialHookCalls.count++
                },
              }
            : {
                onCredentialsChanged: async () => {
                  credentialHookCalls.count++
                },
              }
        const selectedAuthentication =
          strategy === 'session' ? sessionAuthentication : accessTokenAuthentication
        const { config, recorder } = makeService(kit, {
          authentication: selectedAuthentication,
          enabled:
            strategy === 'session' ? [...baseEnabled, 'sessionManagement'] : [...baseEnabled],
          ...credentialHook,
          onLifecycleEvent: async () => {
            lifecycleHookCalls.count++
          },
        })
        const limiter = Object.create(kit.limiter, {
          use: {
            value: () => {
              throw new Error('limiter touched')
            },
          },
        }) as typeof kit.limiter
        const account = new AccountKit({ config, db: kit.db, limiter })
        const now = DateTime.utc()
        await kit.db.table('account_sessions').insert({
          user_id: user.id,
          handle_hash: 's'.repeat(64),
          label: 'inspection session',
          created_at: dbTime(kit, now.minus({ minutes: 20 })),
          last_seen_at: dbTime(kit, now.minus({ minutes: 10 })),
          expires_at: dbTime(kit, now.plus({ days: 1 })),
        })
        await kit.db.table('password_reset_tokens').insert({
          tokenable_id: user.id,
          email: user.email,
          hash: 'r'.repeat(64),
          expires_at: dbTime(kit, now.plus({ hours: 1 })),
          created_at: dbTime(kit, now),
        })
        await kit.db.table('email_verification_tokens').insert({
          tokenable_id: user.id,
          email: 'pending@example.test',
          current_email: user.email,
          purpose: 'email_change',
          hash: 'v'.repeat(64),
          expires_at: dbTime(kit, now.plus({ hours: 1 })),
          created_at: dbTime(kit, now),
        })
        await kit.db.table('login_link_tokens').insert({
          tokenable_id: user.id,
          email: user.email,
          hash: 'l'.repeat(64),
          client_challenge: 'c'.repeat(43),
          expires_at: dbTime(kit, now.plus({ hours: 1 })),
          created_at: dbTime(kit, now),
        })
        if (strategy === 'access_tokens') {
          await kit.db.table('auth_access_tokens').insert({
            tokenable_id: user.id,
            name: 'inspection token',
            hash: 'a'.repeat(64),
            created_at: dbTime(kit, now),
            last_used_at: dbTime(kit, now.minus({ minutes: 1 })),
            expires_at: dbTime(kit, now.plus({ days: 1 })),
          })
        }
        const tables = [
          'users',
          'account_sessions',
          'password_reset_tokens',
          'email_verification_tokens',
          'login_link_tokens',
          'auth_access_tokens',
        ]
        const snapshot = async () =>
          Object.fromEntries(
            await Promise.all(
              tables.map(async (table) => [
                table,
                await kit.db.from(table).select('*').orderBy('id'),
              ])
            )
          )
        const before = await snapshot()
        const callsBefore = [...recorder.calls]
        for (let index = 0; index < 5; index++) {
          await account.authentication.inspectAccountAccess({
            userId: user.id,
            requireActive: true,
          })
        }
        const after = await snapshot()
        for (const table of tables) assert.deepEqual(after[table], before[table], table)
        assert.deepEqual(recorder.calls, callsBefore)
        assert.deepEqual(recorder.calls, [])
        assert.equal(credentialHookCalls.count, 0)
        assert.equal(lifecycleHookCalls.count, 0)
      })
    }
  }

  const inspection = (
    users = makeUsersAdapter(kit.db, kit.hash),
    configOverrides: Partial<AccountKitConfig> = {},
    db = kit.db
  ) => {
    const { config } = makeService(kit, {
      authentication: sessionAuthentication,
      ...configOverrides,
      users,
    })
    return new AccountKit({ config, db, limiter: kit.limiter })
  }

  test('INS-09 propagates a users adapter rejection by identity', async ({ assert }) => {
    const user = await insertUser(kit)
    const cause = new Error('adapter down')
    const base = makeUsersAdapter(kit.db, kit.hash)
    const account = inspection({
      ...base,
      findById: async () => {
        throw cause
      },
    })
    const error = await failure(() =>
      account.authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
    )
    assert.notInstanceOf(error, AccountAccessDeniedError)
    assert.strictEqual(error, cause)
  })

  test('INS-09 rejects invalid adapter metadata before looking up the account', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const base = makeUsersAdapter(kit.db, kit.hash)
    let findByIdCalls = 0
    const account = inspection({
      ...base,
      resolveMetadata: async () => ({
        table: 'users',
        primaryKey: 'uuid' as never,
        emailConstraint: 'users_email_unique',
      }),
      findById: async () => {
        findByIdCalls++
        return null
      },
    })
    const error = await failure(() =>
      account.authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
    )
    assert.notInstanceOf(error, AccountAccessDeniedError)
    assert.equal(
      error.message,
      'account_kit: adapter metadata must use a plain table name and physical id column'
    )
    assert.equal(findByIdCalls, 0)
  })

  test('INS-09 propagates a witness lock query failure before adapter lookup', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const base = makeUsersAdapter(kit.db, kit.hash)
    let findByIdCalls = 0
    const account = inspection({
      ...base,
      resolveMetadata: async () => ({
        table: 'no_such_table',
        primaryKey: 'id',
        emailConstraint: 'users_email_unique',
      }),
      findById: async () => {
        findByIdCalls++
        return null
      },
    })
    const error = await failure(() =>
      account.authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
    )
    assert.notInstanceOf(error, AccountAccessDeniedError)
    const driver = kit.db.connection().getWriteClient().client.driver
    if (testEngine === 'sqlite') assert.instanceOf(error, driver.SqliteError)
    if (testEngine === 'pg') assert.instanceOf(error, driver.DatabaseError)
    assert.equal(
      (error as { code?: string }).code,
      { sqlite: 'SQLITE_ERROR', pg: '42P01', mysql: 'ER_NO_SUCH_TABLE' }[testEngine]
    )
    assert.equal(findByIdCalls, 0)
  })

  test('INS-09 reports a post-commit inspection listener failure without returning a snapshot', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const listener = new Error('listener')
    const { config } = makeService(kit, { authentication: sessionAuthentication })
    const account = new AccountKit({
      config,
      db: faultAfterCommit(kit.db, listener),
      limiter: kit.limiter,
    })
    const error = await failure(() =>
      account.authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
    )
    assert.notInstanceOf(error, AccountAccessDeniedError)
    assert.instanceOf(error, PostCommitError)
    assert.strictEqual((error as PostCommitError).cause, listener)
  })

  test('INS-09 propagates a PostgreSQL COMMIT rejection without returning a snapshot', async ({
    assert,
  }) => {
    if (testEngine !== 'pg') return
    await kit.db
      .rawQuery(
        'CREATE TABLE test_inspection_deferred_commit (id integer PRIMARY KEY, user_id integer REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED)'
      )
      .exec()
    try {
      const user = await insertUser(kit)
      const account = inspection(undefined, {
        authentication: {
          ...sessionAuthentication,
          canAccess: async (_candidate, trx) => {
            await trx.table('test_inspection_deferred_commit').insert({ id: 1, user_id: -1 })
            return true
          },
        },
      })
      const error = await failure(() =>
        account.authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
      )
      assert.notInstanceOf(error, AccountAccessDeniedError)
      assert.notInstanceOf(error, PostCommitError)
      assert.instanceOf(error, kit.db.connection().getWriteClient().client.driver.DatabaseError)
      assert.equal((error as { code?: string }).code, '23503')
    } finally {
      await kit.db.connection().schema.dropTableIfExists('test_inspection_deferred_commit')
    }
  }).skip(testEngine !== 'pg')

  test('INS-09 reports a SQLite cleanup failure without returning a snapshot', async ({
    assert,
  }) => {
    if (testEngine !== 'sqlite') return
    const customKit = await bootTestApp()
    let native: { pragma(sql: string, options?: { simple: boolean }): unknown } | undefined
    let original: ((sql: string, options?: { simple: boolean }) => unknown) | undefined
    const restoreFailure = new Error('timeout restoration failed')
    try {
      await resetSchema(customKit)
      const user = await insertUser(customKit)
      const client = customKit.db.connection().getWriteClient().client
      const connection = (await client.acquireConnection()) as {
        pragma(sql: string, options?: { simple: boolean }): unknown
      }
      native = connection
      original = connection.pragma.bind(connection)
      connection.pragma = (sql, options) => {
        if (sql === 'busy_timeout = 5000') throw restoreFailure
        return original!(sql, options)
      }
      await client.releaseConnection(connection)
      const { config } = makeService(customKit, { authentication: sessionAuthentication })
      const account = new AccountKit({ config, db: customKit.db, limiter: customKit.limiter })
      const error = await failure(() =>
        account.authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
      )
      assert.notInstanceOf(error, AccountAccessDeniedError)
      assert.instanceOf(error, PostCommitError)
      assert.strictEqual((error as PostCommitError).cause, restoreFailure)
    } finally {
      if (native && original) native.pragma = original
      await customKit.close()
    }
  }).skip(testEngine !== 'sqlite')
})
