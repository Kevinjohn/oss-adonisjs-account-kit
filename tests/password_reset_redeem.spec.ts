import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import { generateToken, hashToken } from '../src/tokens.js'
import {
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
import { locksRows } from './helpers/dialect.js'
import { dbTime } from './helpers/db_time.js'
test.group('passwordReset.reset', (group) => {
  const kit = useTestApp(group)

  const service = (overrides: Partial<AccountKitConfig> = {}, users?: AccountKitConfig['users']) =>
    makeService(kit, { minRequestMs: 0, users, ...overrides }).account

  async function issue(options: { verified?: boolean; password?: string | null } = {}) {
    const email = 'person@example.test'
    await insertUser(kit, { password: options.password, verified: options.verified !== false })
    const recorder = makeNotify()
    const account = service({ notify: recorder.notify })
    await account.passwordReset.request({ email, clientKey: 'reset-fixture' })
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
    const result = await account.passwordReset.reset({ token, password: 'new-password123' })
    const stored = await kit.db.from('users').where('id', user.id).first()
    assert.equal(result.id, user.id)
    assert.isTrue(result.hasPassword)
    assert.notEqual(stored.password, 'new-password123')
    assert.isTrue(await kit.hash.verify(stored.password, 'new-password123'))
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
  })

  test('applies the shared new-password policy without consuming a rejected proof', async ({
    assert,
  }) => {
    const { token } = await issue()
    const account = service({ passwordPolicy: { mixedCase: true, numbers: true, minScore: 3 } })
    await assert.rejects(
      () => account.passwordReset.reset({ token, password: 'password123' }),
      InvalidInputError
    )
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
    await account.passwordReset.reset({ token, password: 'LongerPassword12345' })
  })

  test('expired, reused, and malformed tokens cannot change the password', async ({ assert }) => {
    const { account, token, user } = await issue()
    const original = user.password
    await kit.db
      .from('password_reset_tokens')
      .update({ expires_at: dbTime(kit, DateTime.utc().minus({ minute: 1 })) })
    await assert.rejects(
      () => account.passwordReset.reset({ token, password: 'new-password123' }),
      InvalidTokenError
    )
    await assert.rejects(
      () => account.passwordReset.reset({ token: 'bad', password: 'new-password123' }),
      InvalidTokenError
    )
    await assert.rejects(
      () => account.passwordReset.reset({ token: null as never, password: 'new-password123' }),
      InvalidTokenError
    )
    await assert.rejects(
      () => account.passwordReset.reset({ token: generateToken(), password: 'new-password123' }),
      InvalidTokenError
    )
    assert.equal(await storedPassword(), original)
    await kit.db
      .from('password_reset_tokens')
      .update({ expires_at: dbTime(kit, DateTime.utc().plus({ minute: 1 })) })
    await account.passwordReset.reset({ token, password: 'new-password123' })
    await assert.rejects(
      () => account.passwordReset.reset({ token, password: 'another-password' }),
      InvalidTokenError
    )
    assert.notEqual(await storedPassword(), original)
    assert.isFalse(await kit.hash.verify((await storedPassword())!, 'another-password'))
  })

  test('password validation runs first and accepts its length boundaries', async ({ assert }) => {
    const { account, token, user } = await issue()
    for (const password of [null, 123, '1234567', 'x'.repeat(257)]) {
      await assert.rejects(
        () => account.passwordReset.reset({ token: 'bad', password: password as never }),
        InvalidInputError
      )
    }
    assert.equal(await storedPassword(), user.password)
    await account.passwordReset.reset({ token, password: '12345678' })
    assert.isTrue(await kit.hash.verify((await storedPassword())!, '12345678'))
  })

  test('accepts a 256-unit password without changing its bytes', async ({ assert }) => {
    const { account, token } = await issue()
    const password = '😀'.repeat(128)
    await account.passwordReset.reset({ token, password })
    assert.isTrue(await kit.hash.verify((await storedPassword())!, password))
  })

  test('prior-email and deleted-user tokens are rejected', async ({ assert }) => {
    const { account, token, user } = await issue()
    await kit.db.from('users').where('id', user.id).update({ email: 'changed@example.test' })
    await assert.rejects(
      () => account.passwordReset.reset({ token, password: 'new-password123' }),
      InvalidTokenError
    )
    assert.equal(await storedPassword(), user.password)
    await kit.db.from('users').where('id', user.id).delete()
    await assert.rejects(
      () => account.passwordReset.reset({ token, password: 'new-password123' }),
      InvalidTokenError
    )
  })

  test('a stale user lookup rolls back token consumption', async ({ assert }) => {
    const { token } = await issue()
    const users = makeUsersAdapter(kit.db, kit.hash)
    const account = service({}, { ...users, findById: async () => null })
    await assert.rejects(
      () => account.passwordReset.reset({ token, password: 'new-password123' }),
      InvalidTokenError
    )
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
  })

  test('two independent reset transactions allow only one use', async ({ assert }) => {
    const { account, token } = await issue()
    const results = await Promise.allSettled([
      account.passwordReset.reset({ token, password: 'first-password' }),
      account.passwordReset.reset({ token, password: 'second-password' }),
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
      tokenable_id: user.id,
      email: 'next@example.test',
      hash: hashToken(generateToken()),
      expires_at: dbTime(kit, DateTime.utc().plus({ hour: 1 })),
      created_at: dbTime(kit, DateTime.utc()),
    }
    await kit.db.table('email_verification_tokens').insert(emailChange)
    const emailChangeRows = await kit.db.from('email_verification_tokens')
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
      () => account.passwordReset.reset({ token, password: 'new-password123' }),
      failure.message
    )
    assert.equal(await storedPassword(), user.password)
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
    assert.deepEqual(await kit.db.from('email_verification_tokens'), emailChangeRows)
    assert.equal(callbackCalls, 0)
  })

  test('social-only unverified account gains its first password and verification; pending email change is removed', async ({
    assert,
  }) => {
    const { account, token, user } = await issue({ verified: false, password: null })
    await kit.db.table('email_verification_tokens').insert({
      tokenable_id: user.id,
      email: 'next@example.test',
      hash: hashToken(generateToken()),
      expires_at: dbTime(kit, DateTime.utc().plus({ hour: 1 })),
      created_at: dbTime(kit, DateTime.utc()),
    })
    const result = await account.passwordReset.reset({ token, password: 'new-password123' })
    assert.isTrue(result.hasPassword)
    assert.isNotNull(result.emailVerifiedAt)
    assert.isTrue(await kit.hash.verify((await storedPassword())!, 'new-password123'))
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
  })

  test('post-commit callback receives the reloaded user once', async ({ assert }) => {
    const { token } = await issue({ verified: false, password: null })
    const calls: unknown[] = []
    const account = service({
      onCredentialsChanged: async (user) => {
        calls.push(user)
      },
    })
    const result = await account.passwordReset.reset({ token, password: 'new-password123' })
    assert.deepEqual(calls, [result])
    assert.isTrue(result.hasPassword)
    assert.isNotNull(result.emailVerifiedAt)
  })

  test('credential callback runs once after a contended DELETE-journal commit', async ({
    assert,
  }) => {
    if (locksRows) return
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
        email_verified_at: dbTime(kit, DateTime.utc()),
        created_at: dbTime(kit, DateTime.utc()),
      })
      const user = await customKit.db.from('users').first()
      await customKit.db.table('password_reset_tokens').insert({
        tokenable_id: user.id,
        email,
        hash: hashToken(token),
        expires_at: dbTime(kit, DateTime.utc().plus({ hour: 1 })),
        created_at: dbTime(kit, DateTime.utc()),
      })
      reader = await customKit.db.transaction()
      await reader.from('password_reset_tokens').first()
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
      await account.passwordReset.reset({ token, password: 'new-password123' })
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
        passwordResetCompleted: async () => {
          calls.push('notice')
        },
      },
      onLifecycleEvent: async () => {
        calls.push('lifecycle')
      },
    })
    try {
      await account.passwordReset.reset({ token, password: 'new-password123' })
      assert.fail('expected committed failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.deepEqual(calls, ['notice', 'lifecycle'])
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isTrue(await kit.hash.verify(row.password, 'new-password123'))
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
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
      await account.passwordReset.reset({ token, password: 'new-password123' })
      assert.fail('expected PostCommitError')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.isTrue(await kit.hash.verify((await storedPassword())!, 'new-password123'))
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
  })
})

test.group('passwordReset.inspect', (group) => {
  const kit = useTestApp(group)

  async function issue() {
    const users = makeUsersAdapter(kit.db, kit.hash)
    await kit.db.transaction((trx) =>
      users.create(
        {
          email: 'person@example.test',
          password: 'password123',
          unverifiedEmail: null,
        },
        trx
      )
    )
    const recorder = makeNotify()
    const config = defineConfig(makeConfig({ users, notify: recorder.notify, minRequestMs: 0 }))
    const account = accountKit(kit, config)
    await account.passwordReset.request({ email: 'person@example.test', clientKey: 'first' })
    const token = tokenFrom(recorder.calls[0].args[1])
    return { account, token }
  }

  test('valid token remains valid on repeated inspection without consumption', async ({
    assert,
  }) => {
    const { account, token } = await issue()
    assert.isTrue(await account.passwordReset.inspect({ token }))
    assert.isTrue(await account.passwordReset.inspect({ token }))
    const rows = await kit.db.from('password_reset_tokens')
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].hash, hashToken(token))
  })

  test('inspection rejects a proof after the account address changes', async ({ assert }) => {
    const { account, token } = await issue()
    await kit.db.from('users').update({ email: 'replacement@example.test' })
    assert.isFalse(await account.passwordReset.inspect({ token }))
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
  })

  test('expired token is rejected', async ({ assert }) => {
    const { account, token } = await issue()
    await kit.db.from('password_reset_tokens').update({
      expires_at: dbTime(kit, DateTime.utc().minus({ minutes: 1 })),
    })
    assert.isFalse(await account.passwordReset.inspect({ token }))
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
  })

  test('unknown and malformed tokens return false before malformed values reach hashing or the database', async ({
    assert,
  }) => {
    const { account } = await issue()
    assert.isFalse(await account.passwordReset.inspect({ token: generateToken() }))
    for (const token of [null, undefined, 42, {}, [], '', 'a'.repeat(42), '!'.repeat(43)]) {
      assert.isFalse(await account.passwordReset.inspect({ token: token as never }))
    }
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
  })
})

test.group('password reset issuance and redemption boundaries', (group) => {
  const kit = useTestApp(group)

  test('exhausting request issuance does not prevent redeeming the latest valid token', async ({
    assert,
  }) => {
    await insertUser(kit)
    const recorder = makeNotify()
    const { account } = makeService(kit, {
      minRequestMs: 0,
      throttle: { requests: 1, duration: '1h' },
      notify: recorder.notify,
    })

    await account.passwordReset.request({ email: 'person@example.test', clientKey: 'first' })
    const token = tokenFrom(recorder.calls[0].args[1])
    await assert.rejects(
      () => account.passwordReset.request({ email: 'person@example.test', clientKey: 'second' }),
      ThrottledError
    )

    const resetUser = await account.passwordReset.reset({ token, password: 'new-password123' })
    const stored = await kit.db.from('users').where('id', resetUser.id).first()
    assert.equal(resetUser.email, 'person@example.test')
    assert.isTrue(await kit.hash.verify(stored.password, 'new-password123'))
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
    assert.deepEqual(
      recorder.calls.map((call) => call.method),
      ['passwordResetProvision', 'passwordResetCompleted']
    )
  })
})
