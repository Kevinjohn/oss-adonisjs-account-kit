import { performance } from 'node:perf_hooks'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import { requestRecovery } from '../src/recovery.js'
import { generateToken, hashToken } from '../src/tokens.js'
import {
  DeliveryError,
  InvalidInputError,
  InvalidTokenError,
  PostCommitError,
  ThrottledError,
} from '../src/errors.js'
import type { AccountKitConfig } from '../src/types.js'
import { bootTestApp, useTestApp } from './helpers/app.js'
import {
  accountKit,
  insertUser,
  makeConfig,
  makeNotify,
  makeService,
  makeUsersAdapter,
  tokenFrom,
} from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'
test.group('recovery.request', (group) => {
  const kit = useTestApp(group)

  const service = (overrides: Partial<Omit<AccountKitConfig, 'users'>> = {}) =>
    makeService(kit, { minRequestMs: 0, ...overrides })

  const createUser = () => insertUser(kit)

  test('unknown email returns void with no row or notification', async ({ assert }) => {
    const recorder = makeNotify()
    const { account } = service({ notify: recorder.notify })
    assert.isUndefined(
      await account.recovery.request({ email: 'unknown@example.test', clientKey: 'first' })
    )
    assert.isUndefined(
      await account.recovery.request({ email: 'missing@example.test', clientKey: 'second' })
    )
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 0)
    assert.lengthOf(recorder.calls, 0)
  })

  test('stores only a hash of the notified token and the normalized user email', async ({
    assert,
  }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const { account } = service({ notify: recorder.notify })
    assert.isUndefined(
      await account.recovery.request({ email: '  PERSON@EXAMPLE.TEST  ', clientKey: 'first' })
    )
    assert.lengthOf(recorder.calls, 1)
    const [notifiedUser, url] = recorder.calls[0].args
    assert.equal((notifiedUser as typeof user).id, user.id)
    const raw = tokenFrom(url)
    assert.match(raw, /^[A-Za-z0-9_-]{43}$/)
    const rows = await kit.db.from('account_recovery_tokens')
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].user_id, user.id)
    assert.equal(rows[0].email, user.email)
    assert.equal(rows[0].token_hash, hashToken(raw))
    assert.isFalse(Object.values(rows[0]).includes(raw))
    assert.isNotNull(rows[0].expires_at)
    assert.isNotNull(rows[0].created_at)
  })

  test('replaces a previous request and concurrent requests leave one live row', async ({
    assert,
  }) => {
    await createUser()
    const recorder = makeNotify()
    const { account } = service({ notify: recorder.notify })
    await account.recovery.request({ email: 'person@example.test', clientKey: 'first' })
    const first = await kit.db.from('account_recovery_tokens').first()
    await account.recovery.request({ email: 'person@example.test', clientKey: 'second' })
    const second = await kit.db.from('account_recovery_tokens').first()
    assert.notEqual(first.token_hash, second.token_hash)
    await Promise.all([
      account.recovery.request({ email: 'person@example.test', clientKey: 'third' }),
      account.recovery.request({ email: 'person@example.test', clientKey: 'fourth' }),
    ])
    const rows = await kit.db.from('account_recovery_tokens')
    assert.lengthOf(rows, 1)
    const concurrentHashes = recorder.calls
      .slice(2)
      .map((call) => hashToken(tokenFrom(call.args[1])))
    assert.include(concurrentHashes, rows[0].token_hash)
    assert.lengthOf(recorder.calls, 4)
  })

  test('issuance hook sees the locked current user and rolls back a rejected replacement', async ({
    assert,
  }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const failure = new Error('claim refused')
    let calls = 0
    const { account } = service({
      notify: recorder.notify,
      onRecoveryIssuedTransaction: async (current, trx) => {
        calls++
        assert.equal(current.id, user.id)
        assert.equal(current.email, user.email)
        const row = await trx.from('account_recovery_tokens').where('user_id', user.id).first()
        assert.isNotNull(row)
        if (calls === 2) throw failure
      },
    })
    await account.recovery.request({ email: user.email, clientKey: 'first' })
    const before = await kit.db.from('account_recovery_tokens').where('user_id', user.id).first()
    try {
      await account.recovery.request({ email: user.email, clientKey: 'second' })
      assert.fail('expected claim refusal')
    } catch (error) {
      assert.equal(error, failure)
    }
    const after = await kit.db.from('account_recovery_tokens').where('user_id', user.id).first()
    assert.deepEqual(after, before)
    assert.equal(calls, 2)
    assert.lengthOf(recorder.calls, 1)
  })

  test('verified issuance commit fault still captures its delivery once', async ({ assert }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const failure = new Error('issuance listener failed')
    let hooks = 0
    let lifecycle = 0
    const { account } = service({
      notify: recorder.notify,
      onRecoveryIssuedTransaction: async (_current, trx) => {
        hooks++
        trx.on('commit', () => {
          throw failure
        })
      },
      onLifecycleEvent: async () => {
        lifecycle++
      },
    })
    try {
      await account.recovery.request({ email: user.email, clientKey: 'first' })
      assert.fail('expected committed failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.equal(hooks, 1)
    assert.equal(lifecycle, 1)
    assert.lengthOf(recorder.calls, 1)
    const token = tokenFrom(recorder.calls[0].args[1])
    const row = await kit.db.from('account_recovery_tokens').where('user_id', user.id).first()
    assert.equal(row.token_hash, hashToken(token))
  })

  test('stale preflight email does not replace a recovery token or notify', async ({ assert }) => {
    const user = await createUser()
    let hookCalls = 0
    const recorder = makeNotify()
    const users = makeUsersAdapter(kit.db, kit.hash)
    const account = accountKit(
      kit,
      defineConfig(
        makeConfig({
          users: {
            ...users,
            async findByEmail(email, trx, options) {
              const found = await users.findByEmail(email, trx, options)
              if (!trx && found)
                await kit.db
                  .from('users')
                  .where('id', found.id)
                  .update({ email: 'bruce@example.test' })
              return found
            },
          },
          notify: recorder.notify,
          onRecoveryIssuedTransaction: async () => {
            hookCalls++
          },
        })
      )
    )
    await account.recovery.request({ email: user.email, clientKey: 'first' })
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 0)
    assert.equal(hookCalls, 0)
    assert.lengthOf(recorder.calls, 0)
  })

  test('the sixth client request is throttled before user lookup', async ({ assert }) => {
    let lookups = 0
    const users = makeUsersAdapter(kit.db, kit.hash)
    const recorder = makeNotify()
    const config = defineConfig(
      makeConfig({
        users: {
          ...users,
          async findByEmail(email, trx, options) {
            lookups++
            return users.findByEmail(email, trx, options)
          },
        },
        notify: recorder.notify,
        minRequestMs: 0,
      })
    )
    const account = accountKit(kit, config)
    for (let index = 0; index < 5; index++)
      await account.recovery.request({ email: `unknown${index}@example.test`, clientKey: 'same' })
    try {
      await account.recovery.request({ email: 'unknown5@example.test', clientKey: 'same' })
      assert.fail('expected throttle')
    } catch (error) {
      assert.instanceOf(error, ThrottledError)
      assert.isAbove((error as ThrottledError).retryAfterSeconds, 0)
    }
    assert.equal(lookups, 5)
    assert.lengthOf(recorder.calls, 0)
  })

  test('the sixth normalized email request is throttled with varied clients before lookup', async ({
    assert,
  }) => {
    await createUser()
    let lookups = 0
    const users = makeUsersAdapter(kit.db, kit.hash)
    const config = defineConfig(
      makeConfig({
        users: {
          ...users,
          async findByEmail(email, trx, options) {
            lookups++
            return users.findByEmail(email, trx, options)
          },
        },
        minRequestMs: 0,
      })
    )
    const account = accountKit(kit, config)
    for (let index = 0; index < 5; index++)
      await account.recovery.request({ email: 'Person@Example.Test', clientKey: `client${index}` })
    try {
      await account.recovery.request({ email: '  person@example.test  ', clientKey: 'client5' })
      assert.fail('expected throttle')
    } catch (error) {
      assert.instanceOf(error, ThrottledError)
      assert.isAbove((error as ThrottledError).retryAfterSeconds, 0)
    }
    assert.equal(lookups, 5)
  })

  test('delivery failure leaves the committed row and carries its cause', async ({ assert }) => {
    await createUser()
    const recorder = makeNotify()
    recorder.failOn('recovery')
    const { account } = service({ notify: recorder.notify })
    try {
      await account.recovery.request({ email: 'person@example.test', clientKey: 'first' })
      assert.fail('expected delivery failure')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.equal(((error as DeliveryError).cause as Error).message, 'notify.recovery failed')
    }
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 1)
  })

  test('URL callback failure is a delivery error after commit', async ({ assert }) => {
    await createUser()
    const failure = new Error('URL failed')
    const { account } = service({
      urls: {
        ...makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) }).urls,
        recovery: () => {
          throw failure
        },
      },
    })
    try {
      await account.recovery.request({ email: 'person@example.test', clientKey: 'first' })
      assert.fail('expected URL failure')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.equal((error as DeliveryError).cause, failure)
    }
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 1)
  })

  test('known and unknown requests both take at least the configured minimum', async ({
    assert,
  }) => {
    await createUser()
    const { account } = service({ minRequestMs: 40 })
    const unknownStart = performance.now()
    await account.recovery.request({ email: 'unknown@example.test', clientKey: 'first' })
    const unknownElapsed = performance.now() - unknownStart
    const knownStart = performance.now()
    await account.recovery.request({ email: 'person@example.test', clientKey: 'second' })
    const knownElapsed = performance.now() - knownStart
    assert.isAtLeast(unknownElapsed, 40)
    assert.isAtLeast(knownElapsed, 40)
  })

  test('fast unknown callbacks never return before the minimum', async ({ assert }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const config = defineConfig(
      makeConfig({
        users: { ...users, findByEmail: async () => null },
        minRequestMs: 20,
      })
    )
    const limiter = { use: () => ({ consume: async () => {} }) } as never
    for (let index = 0; index < 30; index++) {
      const started = performance.now()
      await requestRecovery(
        { config, db: kit.db, limiter },
        { email: 'unknown@example.test', clientKey: 'fast' }
      )
      assert.isAtLeast(performance.now() - started, 20)
    }
  }).timeout(4000)

  test('fast invalid input never throws before the minimum', async ({ assert }) => {
    const { config } = service({ minRequestMs: 20 })
    const limiter = { use: () => ({ consume: async () => {} }) } as never
    for (let index = 0; index < 30; index++) {
      const started = performance.now()
      try {
        await requestRecovery(
          { config, db: kit.db, limiter },
          { email: 'invalid', clientKey: 'fast' }
        )
        assert.fail('expected InvalidInputError')
      } catch (error) {
        assert.instanceOf(error, InvalidInputError)
      }
      assert.isAtLeast(performance.now() - started, 20)
    }
  }).timeout(4000)

  test('invalid email throws InvalidInputError', async ({ assert }) => {
    const recorder = makeNotify()
    const { account } = service({ notify: recorder.notify })
    for (const email of ['invalid', '@ab', 'ab@', '  @  ', 'a b@example.test'])
      await assert.rejects(
        () => account.recovery.request({ email, clientKey: 'first' }),
        InvalidInputError
      )
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 0)
    assert.lengthOf(recorder.calls, 0)
  })

  test('a missing or blank client key is rejected before any limiter bucket is used', async ({
    assert,
  }) => {
    const { account } = service()
    for (const clientKey of [undefined, '', '   ', 7]) {
      try {
        await account.recovery.request({ email: 'person@example.test', clientKey } as never)
        assert.fail('expected invalid input')
      } catch (error) {
        assert.instanceOf(error, InvalidInputError)
      }
    }
    for (let index = 0; index < 5; index++) {
      await account.recovery.request({ email: `unknown${index}@example.test`, clientKey: 'ok' })
    }
  })
})

test.group('recovery.reset', (group) => {
  const kit = useTestApp(group)

  const service = (overrides: Partial<AccountKitConfig> = {}, users?: AccountKitConfig['users']) =>
    makeService(kit, { minRequestMs: 0, users, ...overrides }).account

  async function issue(options: { verified?: boolean; password?: string | null } = {}) {
    const email = 'person@example.test'
    await insertUser(kit, { password: options.password, verified: options.verified !== false })
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    await account.recovery.request({ email, clientKey: 'reset-fixture' })
    const token = tokenFrom(recorder.calls[0].args[1])
    const user = await kit.db.from('users').first()
    return { account, token, user, recorder }
  }

  async function storedPassword(): Promise<string | null> {
    const row = await kit.db.from('users').first()
    return row.password
  }

  test('consumes a token, hashes the new password, and returns a reloaded user', async ({
    assert,
  }) => {
    const { account, token, user } = await issue()
    const result = await account.recovery.reset({ token, password: 'new-password123' })
    const stored = await kit.db.from('users').where('id', user.id).first()
    assert.equal(result.id, user.id)
    assert.isTrue(result.hasPassword)
    assert.notEqual(stored.password, 'new-password123')
    assert.isTrue(await kit.hash.verify(stored.password, 'new-password123'))
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 0)
  })

  test('expired, reused, and malformed tokens cannot change the password', async ({ assert }) => {
    const { account, token, user } = await issue()
    const original = user.password
    await kit.db
      .from('account_recovery_tokens')
      .update({ expires_at: DateTime.utc().minus({ minute: 1 }).toISO() })
    await assert.rejects(
      () => account.recovery.reset({ token, password: 'new-password123' }),
      InvalidTokenError
    )
    await assert.rejects(
      () => account.recovery.reset({ token: 'bad', password: 'new-password123' }),
      InvalidTokenError
    )
    await assert.rejects(
      () => account.recovery.reset({ token: null as never, password: 'new-password123' }),
      InvalidTokenError
    )
    await assert.rejects(
      () => account.recovery.reset({ token: generateToken(), password: 'new-password123' }),
      InvalidTokenError
    )
    assert.equal(await storedPassword(), original)
    await kit.db
      .from('account_recovery_tokens')
      .update({ expires_at: DateTime.utc().plus({ minute: 1 }).toISO() })
    await account.recovery.reset({ token, password: 'new-password123' })
    await assert.rejects(
      () => account.recovery.reset({ token, password: 'another-password' }),
      InvalidTokenError
    )
    assert.notEqual(await storedPassword(), original)
    assert.isFalse(await kit.hash.verify((await storedPassword())!, 'another-password'))
  })

  test('password validation runs first and accepts its length boundaries', async ({ assert }) => {
    const { account, token, user } = await issue()
    for (const password of [null, 123, '1234567', 'x'.repeat(257)]) {
      await assert.rejects(
        () => account.recovery.reset({ token: 'bad', password: password as never }),
        InvalidInputError
      )
    }
    assert.equal(await storedPassword(), user.password)
    await account.recovery.reset({ token, password: '12345678' })
    assert.isTrue(await kit.hash.verify((await storedPassword())!, '12345678'))
  })

  test('accepts a 256-unit password without changing its bytes', async ({ assert }) => {
    const { account, token } = await issue()
    const password = '😀'.repeat(128)
    await account.recovery.reset({ token, password })
    assert.isTrue(await kit.hash.verify((await storedPassword())!, password))
  })

  test('prior-email and deleted-user tokens are rejected', async ({ assert }) => {
    const { account, token, user } = await issue()
    await kit.db.from('users').where('id', user.id).update({ email: 'changed@example.test' })
    await assert.rejects(
      () => account.recovery.reset({ token, password: 'new-password123' }),
      InvalidTokenError
    )
    assert.equal(await storedPassword(), user.password)
    await kit.db.from('users').where('id', user.id).delete()
    await assert.rejects(
      () => account.recovery.reset({ token, password: 'new-password123' }),
      InvalidTokenError
    )
  })

  test('a stale user lookup rolls back token consumption', async ({ assert }) => {
    const { token } = await issue()
    const users = makeUsersAdapter(kit.db, kit.hash)
    const account = service({}, { ...users, findById: async () => null })
    await assert.rejects(
      () => account.recovery.reset({ token, password: 'new-password123' }),
      InvalidTokenError
    )
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 1)
  })

  test('two independent reset transactions allow only one use', async ({ assert }) => {
    const { account, token } = await issue()
    const results = await Promise.allSettled([
      account.recovery.reset({ token, password: 'first-password' }),
      account.recovery.reset({ token, password: 'second-password' }),
    ])
    assert.lengthOf(
      results.filter((result) => result.status === 'fulfilled'),
      1
    )
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    assert.instanceOf(rejected.reason, InvalidTokenError)
  })

  test('adapter failure rolls back token consumption and password change', async ({ assert }) => {
    const { token, user } = await issue()
    const users = makeUsersAdapter(kit.db, kit.hash)
    const failure = new Error('setPassword failed')
    let callbackCalls = 0
    const emailChange = {
      user_id: user.id,
      current_email: user.email,
      new_email: 'next@example.test',
      token_hash: hashToken(generateToken()),
      expires_at: DateTime.utc().plus({ hour: 1 }).toISO(),
      created_at: DateTime.utc().toISO(),
    }
    await kit.db.table('account_email_changes').insert(emailChange)
    const emailChangeRows = await kit.db.from('account_email_changes')
    const account = service(
      {
        onCredentialsChanged: async () => {
          callbackCalls++
        },
      },
      {
        ...users,
        setPassword: async (id, password, trx) => {
          await users.setPassword(id, password, trx)
          throw failure
        },
      }
    )
    await assert.rejects(
      () => account.recovery.reset({ token, password: 'new-password123' }),
      failure.message
    )
    assert.equal(await storedPassword(), user.password)
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 1)
    assert.deepEqual(await kit.db.from('account_email_changes'), emailChangeRows)
    assert.equal(callbackCalls, 0)
  })

  test('social-only unverified account gains its first password and verification; pending email change is removed', async ({
    assert,
  }) => {
    const { account, token, user } = await issue({ verified: false, password: null })
    await kit.db.table('account_email_changes').insert({
      user_id: user.id,
      current_email: user.email,
      new_email: 'next@example.test',
      token_hash: hashToken(generateToken()),
      expires_at: DateTime.utc().plus({ hour: 1 }).toISO(),
      created_at: DateTime.utc().toISO(),
    })
    const result = await account.recovery.reset({ token, password: 'new-password123' })
    assert.isTrue(result.hasPassword)
    assert.isNotNull(result.emailVerifiedAt)
    assert.isTrue(await kit.hash.verify((await storedPassword())!, 'new-password123'))
    assert.lengthOf(await kit.db.from('account_email_changes'), 0)
  })

  test('post-commit callback receives the reloaded user once', async ({ assert }) => {
    const { token } = await issue({ verified: false, password: null })
    const calls: unknown[] = []
    const account = service({
      onCredentialsChanged: async (user) => {
        calls.push(user)
      },
    })
    const result = await account.recovery.reset({ token, password: 'new-password123' })
    assert.deepEqual(calls, [result])
    assert.isTrue(result.hasPassword)
    assert.isNotNull(result.emailVerifiedAt)
  })

  test('credential callback runs once after a contended DELETE-journal commit', async ({
    assert,
  }) => {
    if (process.env.DB_CLIENT === 'pg') return
    const customKit = await bootTestApp({ sqlitePoolMax: 2 })
    let reader: Awaited<ReturnType<typeof customKit.db.transaction>> | undefined
    let native: { inTransaction: boolean; exec(sql: string): void } | undefined
    let readerReleased = false
    let calls = 0
    let observedCommitted = false
    try {
      await resetSchema(customKit)
      await customKit.db.rawQuery('PRAGMA journal_mode = DELETE').exec()
      const email = 'person@example.test'
      const token = generateToken()
      await customKit.db.table('users').insert({
        email,
        password: await customKit.hash.make('password123'),
        email_verified_at: DateTime.utc().toISO(),
        created_at: DateTime.utc().toISO(),
      })
      const user = await customKit.db.from('users').first()
      await customKit.db.table('account_recovery_tokens').insert({
        user_id: user.id,
        email,
        token_hash: hashToken(token),
        expires_at: DateTime.utc().plus({ hour: 1 }).toISO(),
        created_at: DateTime.utc().toISO(),
      })
      reader = await customKit.db.transaction()
      await reader.from('account_recovery_tokens').first()
      const users = makeUsersAdapter(customKit.db, customKit.hash)
      const config = defineConfig(
        makeConfig({
          minRequestMs: 0,
          users: {
            ...users,
            async setPassword(id, password, trx) {
              native = await trx.getWriteClient().client.acquireConnection()
              await users.setPassword(id, password, trx)
            },
          },
          onCredentialsChanged: async () => {
            calls++
            const row = await customKit.db.from('users').first()
            observedCommitted =
              readerReleased &&
              native?.inTransaction === false &&
              (await customKit.hash.verify(row.password, 'new-password123'))
          },
        })
      )
      const account = accountKit(customKit, config)
      const release = new Promise<void>((resolve, reject) => {
        setTimeout(async () => {
          try {
            await reader!.commit()
            readerReleased = true
            resolve()
          } catch (error) {
            reject(error)
          }
        }, 80)
      })
      await account.recovery.reset({ token, password: 'new-password123' })
      await release
      assert.equal(calls, 1)
      assert.isTrue(observedCommitted)
    } finally {
      if (native?.inTransaction) native.exec('ROLLBACK')
      if (reader && !reader.isCompleted) await reader.rollback()
      await customKit.close()
    }
  }).timeout(8000)

  test('reset attempts notices and lifecycle once after verified COMMIT listener failure', async ({
    assert,
  }) => {
    const { account: unused, token, user } = await issue()
    void unused
    const failure = new Error('reset listener failed')
    const calls: string[] = []
    const account = service({
      onCredentialsChangedTransaction: async (_current, _context, trx) => {
        trx.on('commit', () => {
          throw failure
        })
      },
      notify: {
        ...makeNotify().notify,
        passwordReset: async () => {
          calls.push('notice')
        },
      },
      onLifecycleEvent: async () => {
        calls.push('lifecycle')
      },
    })
    try {
      await account.recovery.reset({ token, password: 'new-password123' })
      assert.fail('expected committed failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.deepEqual(calls, ['notice', 'lifecycle'])
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isTrue(await kit.hash.verify(row.password, 'new-password123'))
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 0)
  })

  test('post-commit failure preserves the changed password and reports its cause', async ({
    assert,
  }) => {
    const { token } = await issue()
    const failure = new Error('callback failed')
    const account = service({
      onCredentialsChanged: async () => {
        throw failure
      },
    })
    try {
      await account.recovery.reset({ token, password: 'new-password123' })
      assert.fail('expected PostCommitError')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.isTrue(await kit.hash.verify((await storedPassword())!, 'new-password123'))
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 0)
  })
})

test.group('recovery.inspect', (group) => {
  const kit = useTestApp(group)

  async function issue() {
    const users = makeUsersAdapter(kit.db, kit.hash)
    await kit.db.transaction((trx) =>
      users.create(
        {
          email: 'person@example.test',
          password: 'password123',
          emailVerifiedAt: DateTime.utc(),
        },
        trx
      )
    )
    const recorder = makeNotify()
    const config = defineConfig(makeConfig({ users, notify: recorder.notify, minRequestMs: 0 }))
    const account = accountKit(kit, config)
    await account.recovery.request({ email: 'person@example.test', clientKey: 'first' })
    const token = tokenFrom(recorder.calls[0].args[1])
    return { account, token }
  }

  test('valid token remains valid on repeated inspection without consumption', async ({
    assert,
  }) => {
    const { account, token } = await issue()
    assert.isTrue(await account.recovery.inspect({ token }))
    assert.isTrue(await account.recovery.inspect({ token }))
    const rows = await kit.db.from('account_recovery_tokens')
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].token_hash, hashToken(token))
  })

  test('expired token is rejected', async ({ assert }) => {
    const { account, token } = await issue()
    await kit.db.from('account_recovery_tokens').update({
      expires_at: DateTime.utc().minus({ minutes: 1 }).toISO(),
    })
    assert.isFalse(await account.recovery.inspect({ token }))
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 1)
  })

  test('unknown and malformed tokens return false before malformed values reach hashing or the database', async ({
    assert,
  }) => {
    const { account } = await issue()
    assert.isFalse(await account.recovery.inspect({ token: generateToken() }))
    for (const token of [null, undefined, 42, {}, [], '', 'a'.repeat(42), '!'.repeat(43)]) {
      assert.isFalse(await account.recovery.inspect({ token: token as never }))
    }
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 1)
  })
})
