import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { AccountKit } from '../src/account_kit.js'
import {
  AccountAccessDeniedError,
  CapabilityDisabledError,
  InvalidInputError,
  PostCommitError,
} from '../src/errors.js'
import { readIsoTimestamp } from '../src/timestamps.js'
import type { AccountKitConfig, Trx } from '../src/types.js'
import { bootTestApp, useTestApp } from './helpers/app.js'
import { insertUser, makeService, makeUsersAdapter } from './helpers/fakes.js'
import { dropPackageTables, resetSchema } from './helpers/schema.js'
import { dbTime } from './helpers/db_time.js'
import { testEngine } from './helpers/dialect.js'
import { faultAfterCommit } from './helpers/fault_after_commit.js'

const authentication = { strategy: 'session' as const, guard: 'web' }

async function failure(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run()
  } catch (error) {
    return error as Error
  }
  throw new Error('Expected inspection to fail')
}

test.group('account access inspection', (group) => {
  const kit = useTestApp(group)
  const service = (overrides: Partial<AccountKitConfig> = {}) =>
    makeService(kit, { authentication, ...overrides }).account

  test('1 session snapshot contains only safe account fields and validates as current', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const account = service()
    await account.authentication.changeRestriction({ userId: user.id, change: async () => {} })
    const snapshot = await account.authentication.inspectAccountAccess({
      userId: user.id,
      requireActive: true,
    })
    assert.isString(snapshot.revision)
    assert.deepEqual(snapshot.account, {
      id: user.id,
      email: user.email,
      unverifiedEmail: null,
      hasPassword: true,
      active: true,
    })
    assert.deepEqual(
      await account.authentication.current({ userId: user.id, revision: snapshot.revision }),
      snapshot.account
    )
    assert.lengthOf(await kit.db.from('account_sessions').where('user_id', user.id), 0)
    assert.lengthOf(await kit.db.from('auth_access_tokens').where('tokenable_id', user.id), 0)
  })

  test('2 access token snapshot issues no credentials', async ({ assert }) => {
    const user = await insertUser(kit)
    const account = service({ authentication: { strategy: 'access_tokens', guard: 'api' } })
    await account.authentication.changeRestriction({ userId: user.id, change: async () => {} })
    const snapshot = await account.authentication.inspectAccountAccess({
      userId: user.id,
      requireActive: true,
    })
    assert.deepEqual(snapshot.account, {
      id: user.id,
      email: user.email,
      unverifiedEmail: null,
      hasPassword: true,
      active: true,
    })
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.equal(snapshot.revision, readIsoTimestamp(row.credentials_changed_at))
    assert.lengthOf(await kit.db.from('account_sessions').where('user_id', user.id), 0)
    assert.lengthOf(await kit.db.from('auth_access_tokens').where('tokenable_id', user.id), 0)
  })

  test('3 revision starts null and follows password changes', async ({ assert }) => {
    const user = await insertUser(kit)
    const account = service()
    const initial = await account.authentication.inspectAccountAccess({
      userId: user.id,
      requireActive: true,
    })
    assert.isNull(initial.revision)
    await account.emailPasswordManagement.changePassword({
      actorId: user.id,
      currentPassword: 'password123',
      newPassword: 'newPassword123',
    })
    const row = await kit.db.from('users').where('id', user.id).first()
    const changed = await account.authentication.inspectAccountAccess({
      userId: user.id,
      requireActive: true,
    })
    assert.equal(changed.revision, readIsoTimestamp(row.credentials_changed_at))
  })

  test('4 corrupt revision is an operational error', async ({ assert }) => {
    const user = await insertUser(kit)
    await kit.db.from('users').where('id', user.id).update({ credentials_changed_at: 'garbage' })
    const error = await failure(() =>
      service().authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
    )
    assert.notInstanceOf(error, AccountAccessDeniedError)
    assert.equal(error.message, 'account_kit: unreadable timestamp value')
  }).skip(testEngine !== 'sqlite')

  test('5 all denial causes have identical public errors', async ({ assert }) => {
    const inactive = await insertUser(kit, { verified: false })
    const errors = await Promise.all([
      failure(() =>
        service().authentication.inspectAccountAccess({ userId: 999999, requireActive: true })
      ),
      failure(() =>
        service({
          authentication: { ...authentication, canAccess: async () => false },
        }).authentication.inspectAccountAccess({ userId: inactive.id, requireActive: false })
      ),
      failure(() =>
        service().authentication.inspectAccountAccess({ userId: inactive.id, requireActive: true })
      ),
    ])
    for (const error of errors) {
      assert.instanceOf(error, AccountAccessDeniedError)
      assert.equal(error.message, 'Account access denied')
      assert.equal((error as AccountAccessDeniedError).code, 'E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED')
      assert.equal((error as AccountAccessDeniedError).status, 403)
      assert.isUndefined(error.cause)
    }
  })

  test('6 inactive accounts are allowed when active is not required', async ({ assert }) => {
    const user = await insertUser(kit, { verified: false })
    const snapshot = await service().authentication.inspectAccountAccess({
      userId: user.id,
      requireActive: false,
    })
    assert.isFalse(snapshot.account.active)
  })

  test('7 confirmed account with pending different address is active', async ({ assert }) => {
    const user = await insertUser(kit)
    await kit.db
      .from('users')
      .where('id', user.id)
      .update({ unverified_email: 'pending@example.test' })
    const snapshot = await service().authentication.inspectAccountAccess({
      userId: user.id,
      requireActive: true,
    })
    assert.isTrue(snapshot.account.active)
  })

  test('8 adapter and policy share one live transaction', async ({ assert }) => {
    const user = await insertUser(kit)
    const base = makeUsersAdapter(kit.db, kit.hash)
    let adapterTrx: Trx | undefined
    let policyTrx: Trx | undefined
    const account = service({
      users: {
        ...base,
        async findById(id, trx) {
          adapterTrx = trx
          assert.isFalse(trx!.isCompleted)
          return base.findById(id, trx)
        },
      },
      authentication: {
        ...authentication,
        canAccess: async (_user, trx) => {
          policyTrx = trx
          assert.isFalse(trx.isCompleted)
          assert.isDefined(await trx.from('users').where('id', user.id).first())
          return true
        },
      },
    })
    await account.authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
    assert.strictEqual(adapterTrx, policyTrx)
  })

  test('9 policy failures propagate and nonboolean policy results are operational', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const boom = new Error('boom')
    assert.strictEqual(
      await failure(() =>
        service({
          authentication: {
            ...authentication,
            canAccess: async () => {
              throw boom
            },
          },
        }).authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
      ),
      boom
    )
    for (const value of ['yes', 1, undefined, 0]) {
      const error = await failure(() =>
        service({
          authentication: { ...authentication, canAccess: async () => value as never },
        }).authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
      )
      assert.notInstanceOf(error, AccountAccessDeniedError)
      assert.equal(error.message, 'account_kit: canAccess must resolve to a boolean')
    }
  })

  test('10 dependency denial errors become operational with their cause', async ({ assert }) => {
    const user = await insertUser(kit)
    const base = makeUsersAdapter(kit.db, kit.hash)
    const deny = async (): Promise<never> => {
      throw new AccountAccessDeniedError()
    }
    for (const overrides of [
      { authentication: { ...authentication, canAccess: deny } },
      { users: { ...base, findById: deny } },
      { users: { ...base, resolveMetadata: deny } },
    ]) {
      const error = await failure(() =>
        service(overrides).authentication.inspectAccountAccess({
          userId: user.id,
          requireActive: true,
        })
      )
      assert.notInstanceOf(error, AccountAccessDeniedError)
      assert.equal(error.message, 'account_kit: dependency threw the inspection denial error')
      assert.instanceOf(error.cause, AccountAccessDeniedError)
    }
  })

  test('11 session registry can be enabled or disabled without a session', async ({ assert }) => {
    const user = await insertUser(kit)
    for (const enabled of [
      undefined,
      [
        'passwordReset',
        'emailVerification',
        'invitations',
        'emailPasswordManagement',
        'sessionManagement',
      ] as const,
    ]) {
      const account = service(enabled ? { enabled: [...enabled] } : {})
      const snapshot = await account.authentication.inspectAccountAccess({
        userId: user.id,
        requireActive: true,
      })
      assert.equal(snapshot.account.id, user.id)
      assert.lengthOf(await kit.db.from('account_sessions').where('user_id', user.id), 0)
    }
  })

  test('12 numeric string lookup preserves the adapter numeric id', async ({ assert }) => {
    const user = await insertUser(kit)
    const snapshot = await service().authentication.inspectAccountAccess({
      userId: String(user.id),
      requireActive: true,
    })
    assert.strictEqual(snapshot.account.id, user.id)
  })

  test('13 adapter cannot substitute a different account', async ({ assert }) => {
    const a = await insertUser(kit)
    const b = await insertUser(kit, { email: 'b@example.test' })
    let policyCalls = 0
    const account = service({
      users: { ...makeUsersAdapter(kit.db, kit.hash), findById: async () => b },
      authentication: {
        ...authentication,
        canAccess: async () => {
          policyCalls++
          return true
        },
      },
    })
    const error = await failure(() =>
      account.authentication.inspectAccountAccess({ userId: a.id, requireActive: true })
    )
    assert.notInstanceOf(error, AccountAccessDeniedError)
    assert.equal(
      error.message,
      'account_kit: users adapter returned a different account than requested'
    )
    assert.equal(policyCalls, 0)
  })

  test('14 absent adapter account is denied and malformed adapter id is operational', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const base = makeUsersAdapter(kit.db, kit.hash)
    const absent = await failure(() =>
      service({
        users: { ...base, findById: async () => null },
      }).authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
    )
    assert.instanceOf(absent, AccountAccessDeniedError)
    assert.equal(absent.message, 'Account access denied')
    assert.equal((absent as AccountAccessDeniedError).code, 'E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED')
    assert.equal((absent as AccountAccessDeniedError).status, 403)
    const malformed = await failure(() =>
      service({
        users: { ...base, findById: async () => ({ ...user, id: ['1'] as never }) },
      }).authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
    )
    assert.notInstanceOf(malformed, AccountAccessDeniedError)
    assert.equal(malformed.message, 'account_kit: users adapter returned a malformed account id')
  })

  test('16 invalid inputs perform no metadata lookup adapter lookup or transaction', async ({
    assert,
  }) => {
    let lookups = 0
    let metadata = 0
    let transactions = 0
    const base = makeUsersAdapter(kit.db, kit.hash)
    const { config } = makeService(kit, {
      authentication,
      users: {
        ...base,
        findById: async () => {
          lookups++
          return null
        },
        resolveMetadata: async () => {
          metadata++
          return { table: 'users', primaryKey: 'id' }
        },
      },
    })
    const db = Object.create(kit.db, {
      connection: {
        value: (...args: Parameters<typeof kit.db.connection>) => {
          const client = kit.db.connection(...args)
          const begin = client.transaction.bind(client)
          client.transaction = ((...rest: Parameters<typeof begin>) => {
            transactions++
            return begin(...rest)
          }) as typeof client.transaction
          return client
        },
      },
    })
    const account = new AccountKit({ config, db, limiter: kit.limiter })
    for (const input of [
      undefined,
      null,
      {},
      { userId: 1 },
      { userId: 1, requireActive: 'yes' },
      { userId: '', requireActive: true },
      { userId: 1.5, requireActive: true },
      { userId: 2 ** 53, requireActive: true },
    ]) {
      assert.instanceOf(
        await failure(() => account.authentication.inspectAccountAccess(input as never)),
        InvalidInputError
      )
    }
    assert.deepEqual([lookups, metadata, transactions], [0, 0, 0])
  })

  test('17 validation precedes disabled authentication', async ({ assert }) => {
    const account = service({ authentication: undefined })
    assert.instanceOf(
      await failure(() =>
        account.authentication.inspectAccountAccess({ userId: 1, requireActive: true })
      ),
      CapabilityDisabledError
    )
    assert.instanceOf(
      await failure(() =>
        account.authentication.inspectAccountAccess({ userId: '', requireActive: true })
      ),
      InvalidInputError
    )
  })

  test('18 extra credential fields do not change the snapshot', async ({ assert }) => {
    const user = await insertUser(kit)
    const account = service()
    assert.deepEqual(
      await account.authentication.inspectAccountAccess({
        userId: user.id,
        requireActive: true,
        revision: 'x',
        expectedRevision: 'y',
        tokenId: 1,
        sessionHandle: 'h',
      } as never),
      await account.authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
    )
  })

  test('19 input getters are copied once before awaiting', async ({ assert }) => {
    const a = await insertUser(kit, { verified: false })
    const b = await insertUser(kit, { email: 'b@example.test' })
    let ids = 0
    let active = 0
    const input = {
      get userId() {
        return ids++ === 0 ? a.id : b.id
      },
      get requireActive() {
        return active++ === 0
      },
    }
    assert.instanceOf(
      await failure(() => service().authentication.inspectAccountAccess(input)),
      AccountAccessDeniedError
    )
    assert.deepEqual([ids, active], [1, 1])
  })
})

for (const scenario of [
  '15 string ids',
  '20 custom members table',
  '21 PostgreSQL UUID canonicalization',
]) {
  test(scenario, async ({ assert }) => {
    const kit = await bootTestApp()
    const members = scenario.startsWith('20')
    const uuidColumn = scenario.startsWith('21')
    const table = members ? 'members' : 'users'
    try {
      if (uuidColumn) {
        const schema = kit.db.connection().schema
        await dropPackageTables(schema)
        await schema.dropTableIfExists('users')
        await schema.createTable('users', (builder) => {
          builder.uuid('id').primary()
          builder.string('email').notNullable()
          builder.string('unverified_email').nullable()
          builder.string('password').nullable()
          builder.timestamp('email_verified_at').nullable()
          builder.timestamp('credentials_changed_at').nullable()
          builder.timestamp('created_at').notNullable()
        })
      } else {
        await resetSchema(kit, { stringUserIds: !members, usersTable: table })
      }
      const id = members ? 1 : randomUUID()
      await kit.db.table(table).insert({
        id,
        email: 'person@example.test',
        unverified_email: null,
        password: await kit.hash.make('password123'),
        email_verified_at: dbTime(kit),
        created_at: dbTime(kit),
      })
      let metadata = 0
      const base = makeUsersAdapter(kit.db, kit.hash, table)
      const users: typeof base = { ...base }
      const { account } = makeService(kit, {
        authentication,
        usersTable: table,
        users,
      })
      // Add the metadata observer after config validation: explicit table overrides and
      // metadata-bearing adapters cannot be supplied together at configuration time.
      users.resolveMetadata = async () => {
        metadata++
        return { table, primaryKey: 'id' }
      }
      const snapshot = await account.authentication.inspectAccountAccess({
        userId: uuidColumn ? String(id).toUpperCase() : id,
        requireActive: true,
      })
      assert.strictEqual(snapshot.account.id, id)
      assert.isAbove(metadata, 0)
      if (!members)
        assert.instanceOf(
          await failure(() =>
            account.authentication.inspectAccountAccess({
              userId: randomUUID(),
              requireActive: true,
            })
          ),
          AccountAccessDeniedError
        )
    } finally {
      await kit.close()
    }
  }).skip(uuidScenarioDisabled(scenario))
}

function uuidScenarioDisabled(scenario: string) {
  return scenario.startsWith('21') && testEngine !== 'pg'
}

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
