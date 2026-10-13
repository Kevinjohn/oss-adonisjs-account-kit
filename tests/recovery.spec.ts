import { performance } from 'node:perf_hooks'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import { requestRecovery } from '../src/recovery.js'
import { hashToken } from '../src/tokens.js'
import { DeliveryError, InvalidInputError, ThrottledError } from '../src/errors.js'
import type { AccountKitConfig } from '../src/types.js'
import { bootTestApp } from './helpers/app.js'
import { makeConfig, makeNotify, makeUsersAdapter } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'

test.group('recovery.request', (group) => {
  let kit: Awaited<ReturnType<typeof bootTestApp>>
  group.setup(async () => {
    kit = await bootTestApp()
  })
  group.each.setup(async () => {
    await resetSchema(kit)
    await kit.limiter.clear()
  })
  group.teardown(async () => {
    await kit.close()
  })

  function service(overrides: Partial<Omit<AccountKitConfig, 'users'>> = {}) {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const config = defineConfig(makeConfig({ users, minRequestMs: 0, ...overrides }))
    return {
      users,
      config,
      account: new AccountKit({
        config,
        db: kit.db,
        limiter: kit.limiter,
        encryption: null as never,
      }),
    }
  }

  async function createUser() {
    const users = makeUsersAdapter(kit.db, kit.hash)
    return kit.db.transaction((trx) =>
      users.create(
        { email: 'person@example.test', password: 'password123', emailVerifiedAt: DateTime.utc() },
        trx
      )
    )
  }

  test('unknown email returns void with no row or notification', async ({ assert }) => {
    const recorder = makeNotify()
    const { account } = service({ notify: recorder.notify })
    assert.isUndefined(
      await account.recovery.request({ email: 'unknown@example.test', clientKey: 'first' })
    )
    assert.isUndefined(await account.recovery.request({ email: ' @ ', clientKey: 'second' }))
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
    const raw = new URL(url as string).pathname.split('/').at(-1)!
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
      .map((call) => hashToken(new URL(call.args[1] as string).pathname.split('/').at(-1)!))
    assert.include(concurrentHashes, rows[0].token_hash)
    assert.lengthOf(recorder.calls, 4)
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
    const account = new AccountKit({
      config,
      db: kit.db,
      limiter: kit.limiter,
      encryption: null as never,
    })
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
    const account = new AccountKit({
      config,
      db: kit.db,
      limiter: kit.limiter,
      encryption: null as never,
    })
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
    const { account } = service()
    try {
      await account.recovery.request({ email: 'invalid', clientKey: 'first' })
      assert.fail('expected invalid input')
    } catch (error) {
      assert.instanceOf(error, InvalidInputError)
    }
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 0)
  })
})
