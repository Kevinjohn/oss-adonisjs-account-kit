import { performance } from 'node:perf_hooks'
import { test } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import { requestPasswordReset } from '../src/password_reset.js'
import { hashToken } from '../src/tokens.js'
import { DeliveryError, InvalidInputError, PostCommitError, ThrottledError } from '../src/errors.js'
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
test.group('passwordReset.request', (group) => {
  const kit = useTestApp(group)

  const service = (overrides: Partial<Omit<AccountKitConfig, 'users'>> = {}) =>
    makeService(kit, { minRequestMs: 0, ...overrides })

  const createUser = () => insertUser(kit)

  test('unknown email returns void with no row or notification', async ({ assert }) => {
    const recorder = makeNotify()
    const { account } = service({ notify: recorder.notify })
    assert.isUndefined(
      await account.passwordReset.request({ email: 'unknown@example.test', clientKey: 'first' })
    )
    assert.isUndefined(
      await account.passwordReset.request({ email: 'missing@example.test', clientKey: 'second' })
    )
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
    assert.lengthOf(recorder.calls, 0)
  })

  test('stores only a hash of the notified token and the normalized user email', async ({
    assert,
  }) => {
    const user = await createUser()
    const recorder = makeNotify()
    const { account } = service({ notify: recorder.notify })
    assert.isUndefined(
      await account.passwordReset.request({ email: '  PERSON@EXAMPLE.TEST  ', clientKey: 'first' })
    )
    assert.lengthOf(recorder.calls, 1)
    const [notifiedUser, url] = recorder.calls[0].args
    assert.equal((notifiedUser as typeof user).id, user.id)
    const raw = tokenFrom(url)
    assert.match(raw, /^[A-Za-z0-9_-]{54}$/)
    const rows = await kit.db.from('password_reset_tokens')
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].tokenable_id, user.id)
    assert.equal(rows[0].email, user.email)
    assert.equal(rows[0].hash, hashToken(raw))
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
    await account.passwordReset.request({ email: 'person@example.test', clientKey: 'first' })
    const first = await kit.db.from('password_reset_tokens').first()
    await account.passwordReset.request({ email: 'person@example.test', clientKey: 'second' })
    const second = await kit.db.from('password_reset_tokens').first()
    assert.notEqual(first.hash, second.hash)
    await Promise.all([
      account.passwordReset.request({ email: 'person@example.test', clientKey: 'third' }),
      account.passwordReset.request({ email: 'person@example.test', clientKey: 'fourth' }),
    ])
    const rows = await kit.db.from('password_reset_tokens')
    assert.lengthOf(rows, 1)
    const concurrentHashes = recorder.calls
      .slice(2)
      .map((call) => hashToken(tokenFrom(call.args[1])))
    assert.include(concurrentHashes, rows[0].hash)
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
      onPasswordResetIssuedTransaction: async (current, trx) => {
        calls++
        assert.equal(current.id, user.id)
        assert.equal(current.email, user.email)
        const row = await trx.from('password_reset_tokens').where('tokenable_id', user.id).first()
        assert.isNotNull(row)
        if (calls === 2) throw failure
      },
    })
    await account.passwordReset.request({ email: user.email, clientKey: 'first' })
    const before = await kit.db.from('password_reset_tokens').where('tokenable_id', user.id).first()
    try {
      await account.passwordReset.request({ email: user.email, clientKey: 'second' })
      assert.fail('expected claim refusal')
    } catch (error) {
      assert.equal(error, failure)
    }
    const after = await kit.db.from('password_reset_tokens').where('tokenable_id', user.id).first()
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
      onPasswordResetIssuedTransaction: async (_current, trx) => {
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
      await account.passwordReset.request({ email: user.email, clientKey: 'first' })
      assert.fail('expected committed failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.equal(hooks, 1)
    assert.equal(lifecycle, 1)
    assert.lengthOf(recorder.calls, 1)
    const token = tokenFrom(recorder.calls[0].args[1])
    const row = await kit.db.from('password_reset_tokens').where('tokenable_id', user.id).first()
    assert.equal(row.hash, hashToken(token))
  })

  test('stale preflight email does not replace a password reset token or notify', async ({
    assert,
  }) => {
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
          onPasswordResetIssuedTransaction: async () => {
            hookCalls++
          },
        })
      )
    )
    await account.passwordReset.request({ email: user.email, clientKey: 'first' })
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
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
      await account.passwordReset.request({
        email: `unknown${index}@example.test`,
        clientKey: 'same',
      })
    try {
      await account.passwordReset.request({ email: 'unknown5@example.test', clientKey: 'same' })
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
      await account.passwordReset.request({
        email: 'Person@Example.Test',
        clientKey: `client${index}`,
      })
    try {
      await account.passwordReset.request({
        email: '  person@example.test  ',
        clientKey: 'client5',
      })
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
    recorder.failOn('passwordResetProvision')
    const { account } = service({ notify: recorder.notify })
    try {
      await account.passwordReset.request({ email: 'person@example.test', clientKey: 'first' })
      assert.fail('expected delivery failure')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.equal(
        ((error as DeliveryError).cause as Error).message,
        'notify.passwordResetProvision failed'
      )
    }
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
  })

  test('URL callback failure is a delivery error after commit', async ({ assert }) => {
    await createUser()
    const failure = new Error('URL failed')
    const { account } = service({
      urls: {
        ...makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) }).urls,
        passwordReset: () => {
          throw failure
        },
      },
    })
    try {
      await account.passwordReset.request({ email: 'person@example.test', clientKey: 'first' })
      assert.fail('expected URL failure')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.equal((error as DeliveryError).cause, failure)
    }
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
  })

  test('known and unknown requests both take at least the configured minimum', async ({
    assert,
  }) => {
    await createUser()
    const { account } = service({ minRequestMs: 40 })
    const unknownStart = performance.now()
    await account.passwordReset.request({ email: 'unknown@example.test', clientKey: 'first' })
    const unknownElapsed = performance.now() - unknownStart
    const knownStart = performance.now()
    await account.passwordReset.request({ email: 'person@example.test', clientKey: 'second' })
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
      await requestPasswordReset(
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
        await requestPasswordReset(
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
        () => account.passwordReset.request({ email, clientKey: 'first' }),
        InvalidInputError
      )
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
    assert.lengthOf(recorder.calls, 0)
  })

  test('a missing or blank client key is rejected before any limiter bucket is used', async ({
    assert,
  }) => {
    const { account } = service()
    for (const clientKey of [undefined, '', '   ', 7]) {
      try {
        await account.passwordReset.request({ email: 'person@example.test', clientKey } as never)
        assert.fail('expected invalid input')
      } catch (error) {
        assert.instanceOf(error, InvalidInputError)
      }
    }
    for (let index = 0; index < 5; index++) {
      await account.passwordReset.request({
        email: `unknown${index}@example.test`,
        clientKey: 'ok',
      })
    }
  })
})
