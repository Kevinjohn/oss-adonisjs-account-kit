import { test, timeTravel } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import {
  DeliveryError,
  InvalidInputError,
  InvalidTokenError,
  ThrottledError,
} from '../src/errors.js'
import { lockRow, transaction } from '../src/db.js'
import type { AccountKitConfig } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import {
  accountKit,
  insertUser,
  makeConfig,
  makeNotify,
  makeService,
  makeUsersAdapter,
  tokenFrom,
} from './helpers/fakes.js'
test.group('verification.send', (group) => {
  const kit = useTestApp(group)

  const createUser = async (verified = false) => {
    const user = await insertUser(kit, { verified })
    return user.id
  }

  const service = (overrides: Partial<AccountKitConfig> = {}) => makeService(kit, overrides)

  test('notifies an unverified user with an encrypted, purpose-bound payload', async ({
    assert,
  }) => {
    const id = await createUser()
    const { account, recorder } = service({ ttl: { verification: '2h' } })
    assert.equal(await account.verification.send({ userId: id }), 'sent')
    assert.lengthOf(recorder.calls, 1)
    assert.equal(recorder.calls[0].method, 'verification')
    const [user, url] = recorder.calls[0].args
    assert.equal((user as { id: number }).id, id)
    const token = tokenFrom(url)
    assert.deepEqual(kit.encryption.decrypt(token, 'account-kit:verify-email'), {
      userId: id,
      email: 'person@example.test',
    })
    assert.isNull(kit.encryption.decrypt(token, 'wrong-purpose'))
  })

  test('missing user rejects and verified user returns without throttling or notification', async ({
    assert,
  }) => {
    const id = await createUser(true)
    const { account, recorder } = service()
    await assert.rejects(() => account.verification.send({ userId: 99999 }), InvalidInputError)
    for (let index = 0; index < 6; index++)
      assert.equal(await account.verification.send({ userId: id }), 'already_verified')
    assert.lengthOf(recorder.calls, 0)
  })

  test('sixth unverified send is throttled', async ({ assert }) => {
    const id = await createUser()
    const { account, recorder } = service()
    for (let index = 0; index < 5; index++)
      assert.equal(await account.verification.send({ userId: id }), 'sent')
    try {
      await account.verification.send({ userId: id })
      assert.fail('expected throttle')
    } catch (error) {
      assert.instanceOf(error, ThrottledError)
      assert.isAbove((error as ThrottledError).retryAfterSeconds, 0)
    }
    assert.lengthOf(recorder.calls, 5)
  })

  test('notification and URL failures carry their cause', async ({ assert }) => {
    const id = await createUser()
    const recorder = makeNotify()
    recorder.failOn('verification')
    const { account } = service({ notify: recorder.notify })
    try {
      await account.verification.send({ userId: id })
      assert.fail('expected delivery failure')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.equal((error as DeliveryError).cause instanceof Error, true)
    }
    const failure = new Error('URL failed')
    const defaults = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    const { account: brokenUrl } = service({
      urls: {
        ...defaults.urls,
        verification: () => {
          throw failure
        },
      },
    })
    try {
      await brokenUrl.verification.send({ userId: id })
      assert.fail('expected URL failure')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.equal((error as DeliveryError).cause, failure)
    }
  })
})

test.group('verification.complete', (group) => {
  const kit = useTestApp(group)

  const createUser = async (verified = false) => {
    const user = await insertUser(kit, { verified })
    return user.id
  }

  const service = (overrides: Partial<AccountKitConfig> = {}) => makeService(kit, overrides)

  async function issue() {
    const id = await createUser()
    const { account, recorder } = service()
    await account.verification.send({ userId: id })
    const token = tokenFrom(recorder.calls[0].args[1])
    return { id, account, token }
  }

  test('marks the current email verified; a repeat visit is already verified', async ({
    assert,
  }) => {
    const { id, account, token } = await issue()
    let callbacks = 0
    const withCallback = service({
      onCredentialsChanged: async () => {
        callbacks++
      },
    }).account
    assert.equal(await withCallback.verification.complete({ token }), 'verified')
    const verified = await kit.db.from('users').where('id', id).first()
    assert.isNotNull(verified.email_verified_at)
    assert.equal(await account.verification.complete({ token }), 'already_verified')
    assert.equal(callbacks, 0)
  })

  test('rejects a token encrypted for another purpose', async ({ assert }) => {
    const id = await createUser()
    const { account } = service()
    const payload = { userId: id, email: 'person@example.test' }
    const wrongPurpose = kit.encryption.encrypt(payload, '1h', 'different-purpose')
    await assert.rejects(
      () => account.verification.complete({ token: wrongPurpose }),
      InvalidTokenError
    )
    const row = await kit.db.from('users').where('id', id).first()
    assert.isNull(row.email_verified_at)
  })

  test('rejects an expired token', async ({ assert }) => {
    const id = await createUser()
    const { account } = service()
    const expired = kit.encryption.encrypt(
      { userId: id, email: 'person@example.test' },
      '1h',
      'account-kit:verify-email'
    )
    timeTravel(new Date(Date.now() + 3_600_001))
    await assert.rejects(() => account.verification.complete({ token: expired }), InvalidTokenError)
    const row = await kit.db.from('users').where('id', id).first()
    assert.isNull(row.email_verified_at)
  })

  test('rejects malformed and wrong-shaped tokens', async ({ assert }) => {
    const id = await createUser()
    const { account } = service()
    const payload = { userId: id, email: 'person@example.test' }
    for (const value of [null, 42, '', 'not-encrypted'])
      await assert.rejects(
        () => account.verification.complete({ token: value as never }),
        InvalidTokenError
      )
    for (const invalid of [
      null,
      [],
      {},
      { userId: true, email: payload.email },
      { userId: id, email: 42 },
    ]) {
      const token = kit.encryption.encrypt(invalid, '1h', 'account-kit:verify-email')
      await assert.rejects(() => account.verification.complete({ token }), InvalidTokenError)
    }
    const row = await kit.db.from('users').where('id', id).first()
    assert.isNull(row.email_verified_at)
  })

  test('rejects a prior-email token and a deleted user', async ({ assert }) => {
    const { id, account, token } = await issue()
    await kit.db.from('users').where('id', id).update({ email: 'changed@example.test' })
    await assert.rejects(() => account.verification.complete({ token }), InvalidTokenError)
    const row = await kit.db.from('users').where('id', id).first()
    assert.isNull(row.email_verified_at)
    await kit.db.from('users').where('id', id).delete()
    await assert.rejects(() => account.verification.complete({ token }), InvalidTokenError)
  })

  test('holds the user lock while checking the current email', async ({ assert }) => {
    const { id, token } = await issue()
    const users = makeUsersAdapter(kit.db, kit.hash)
    let lookupReady!: () => void
    let releaseLookup!: () => void
    const ready = new Promise<void>((resolve) => {
      lookupReady = resolve
    })
    const holdLookup = new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
    const config = defineConfig(
      makeConfig({
        users: {
          ...users,
          async findById(userId, trx, options) {
            const user = await users.findById(userId, trx, options)
            lookupReady()
            await holdLookup
            return user
          },
        },
      })
    )
    const account = accountKit(kit, config)
    const verifying = account.verification.complete({ token })
    try {
      await ready
      await assert.rejects(async () => {
        await kit.db.transaction(async (trx) => {
          if (process.env.DB_CLIENT === 'pg') {
            await trx.rawQuery('SELECT id FROM users WHERE id = ? FOR UPDATE NOWAIT', [id]).exec()
          } else {
            const prior = await trx.rawQuery('PRAGMA busy_timeout').exec()
            await trx.rawQuery('PRAGMA busy_timeout = 0').exec()
            try {
              await trx.rawQuery('UPDATE users SET id = id WHERE id = ?', [id]).exec()
            } finally {
              await trx.rawQuery(`PRAGMA busy_timeout = ${prior[0].timeout}`).exec()
            }
          }
        })
      })
    } finally {
      releaseLookup()
      await verifying
    }
    const row = await kit.db.from('users').where('id', id).first()
    assert.isNotNull(row.email_verified_at)
  })

  test('an email change holding the user lock prevents verification of the replacement address', async ({
    assert,
  }) => {
    const { id, account, token } = await issue()
    let releaseChange!: () => void
    let changeReady!: () => void
    const holdChange = new Promise<void>((resolve) => {
      releaseChange = resolve
    })
    const ready = new Promise<void>((resolve) => {
      changeReady = resolve
    })
    const users = makeUsersAdapter(kit.db, kit.hash)
    const changing = transaction(kit.db, async (trx) => {
      await lockRow(trx, 'users', id)
      await users.findById(id, trx, { forUpdate: true })
      await users.setEmail(id, 'changed@example.test', trx)
      changeReady()
      await holdChange
    })
    await ready
    const knex = kit.db.connection().getWriteClient()
    let attempted!: () => void
    const attemptedLock = new Promise<void>((resolve) => {
      attempted = resolve
    })
    const onQuery = (query: { sql: string }) => {
      if (/update ["`]?users["`]? set id = id|for update/i.test(query.sql)) attempted()
    }
    knex.on('query', onQuery)
    try {
      const verifying = account.verification.complete({ token })
      await attemptedLock
      releaseChange()
      await changing
      await assert.rejects(() => verifying, InvalidTokenError)
      const row = await kit.db.from('users').where('id', id).first()
      assert.equal(row.email, 'changed@example.test')
      assert.isNull(row.email_verified_at)
    } finally {
      releaseChange()
      knex.off('query', onQuery)
      await changing
    }
  }).timeout(5000)
})
