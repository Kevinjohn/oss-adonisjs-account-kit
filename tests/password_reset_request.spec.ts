import { Settings } from 'luxon'
import { performance } from 'node:perf_hooks'
import { test } from '@japa/runner'
import { resolveConfig as defineConfig } from '../src/config.ts'
import { requestPasswordReset } from '../src/password_reset.ts'
import { hashToken } from '../src/tokens.ts'
import {
  E_ACCOUNT_KIT_DELIVERY,
  E_ACCOUNT_KIT_INVALID_INPUT,
  E_ACCOUNT_KIT_POST_COMMIT,
  E_ACCOUNT_KIT_THROTTLED,
} from '../src/errors.ts'
import type { AccountKitConfig } from '../src/types.ts'
import { useTestApp } from './helpers/app.ts'
import { serviceDependencies } from './helpers/service_dependencies.ts'
import {
  accountKit,
  insertUser,
  makeConfig,
  makeNotify,
  makeService,
  makeUsersAdapter,
  tokenFrom,
} from './helpers/fakes.ts'
test.group('passwordReset.request', (group) => {
  const kit = useTestApp(group)

  const service = (overrides: Partial<Omit<AccountKitConfig, 'users'>> = {}) =>
    makeService(kit, { minRequestMs: 0, ...overrides })

  const createUser = () => insertUser(kit)

  test('starts the proof lifetime after the locked account read', async ({ assert, cleanup }) => {
    const user = await insertUser(kit)
    const users = makeUsersAdapter(kit.db, kit.hash)
    const originalNow = Settings.now
    let now = Date.UTC(2026, 10, 16, 12)
    Settings.now = () => now
    cleanup(() => {
      Settings.now = originalNow
    })
    const { account, recorder } = makeService(kit, {
      minRequestMs: 0,
      expiresIn: { passwordReset: '1s' },
      users: {
        ...users,
        async findById(id, trx) {
          const current = await users.findById(id, trx)
          now += 2000
          return current
        },
      },
    })
    await account.passwordReset.request({ email: user.email, clientKey: 'clock' })
    const token = tokenFrom(recorder.calls[0].args[1])
    assert.isTrue(await account.passwordReset.inspect({ token }))
  })

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

  test('distinguishes delivery-only, observer-only and combined follow-up failures', async ({
    assert,
  }) => {
    const observerFault = new Error('observer failed')
    const run = async (delivery: boolean, observer: boolean) => {
      const user = await insertUser(kit, { email: `${delivery}-${observer}@example.test` })
      const recorder = makeNotify()
      if (delivery) recorder.failOn('passwordResetProvision')
      const { account } = service({
        notify: recorder.notify,
        onLifecycleEvent: async () => {
          if (observer) throw observerFault
        },
      })
      const error = await account.passwordReset
        .request({ email: user.email, clientKey: `${delivery}-${observer}` })
        .then(
          () => null,
          (caught: unknown) => caught
        )
      return { error, user }
    }

    const deliveryOnly = await run(true, false)
    assert.instanceOf(deliveryOnly.error, E_ACCOUNT_KIT_DELIVERY)

    const observerOnly = await run(false, true)
    assert.instanceOf(observerOnly.error, E_ACCOUNT_KIT_POST_COMMIT)
    assert.equal(
      (observerOnly.error as InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT>).cause,
      observerFault
    )

    const combined = await run(true, true)
    assert.instanceOf(combined.error, E_ACCOUNT_KIT_POST_COMMIT)
    const cause = (combined.error as InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT>).cause
    assert.deepEqual(
      (cause as Error[]).map((error: Error) => error.message),
      ['notify.passwordResetProvision failed', 'observer failed']
    )
    for (const { error, user } of [deliveryOnly, observerOnly, combined])
      assert.notInclude((error as Error).message, user.email)
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
      assert.instanceOf(error, E_ACCOUNT_KIT_POST_COMMIT)
      assert.equal((error as InstanceType<typeof E_ACCOUNT_KIT_POST_COMMIT>).cause, failure)
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
            async findByEmail(email, trx) {
              const found = await users.findByEmail(email, trx)
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
          async findByEmail(email, trx) {
            lookups++
            return users.findByEmail(email, trx)
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
      assert.instanceOf(error, E_ACCOUNT_KIT_THROTTLED)
      assert.isAbove((error as InstanceType<typeof E_ACCOUNT_KIT_THROTTLED>).retryAfterSeconds, 0)
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
          async findByEmail(email, trx) {
            lookups++
            return users.findByEmail(email, trx)
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
      assert.instanceOf(error, E_ACCOUNT_KIT_THROTTLED)
      assert.isAbove((error as InstanceType<typeof E_ACCOUNT_KIT_THROTTLED>).retryAfterSeconds, 0)
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
      assert.instanceOf(error, E_ACCOUNT_KIT_DELIVERY)
      assert.equal(
        ((error as InstanceType<typeof E_ACCOUNT_KIT_DELIVERY>).cause as Error).message,
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
      assert.instanceOf(error, E_ACCOUNT_KIT_DELIVERY)
      assert.equal((error as InstanceType<typeof E_ACCOUNT_KIT_DELIVERY>).cause, failure)
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
      await requestPasswordReset(serviceDependencies({ config, db: kit.db, limiter }), {
        email: 'unknown@example.test',
        clientKey: 'fast',
      })
      assert.isAtLeast(performance.now() - started, 20)
    }
  }).timeout(4000)

  test('fast invalid input never throws before the minimum', async ({ assert }) => {
    const { config } = service({ minRequestMs: 20 })
    const limiter = { use: () => ({ consume: async () => {} }) } as never
    for (let index = 0; index < 30; index++) {
      const started = performance.now()
      try {
        await requestPasswordReset(serviceDependencies({ config, db: kit.db, limiter }), {
          email: 'invalid',
          clientKey: 'fast',
        })
        assert.fail('expected E_ACCOUNT_KIT_INVALID_INPUT')
      } catch (error) {
        assert.instanceOf(error, E_ACCOUNT_KIT_INVALID_INPUT)
      }
      assert.isAtLeast(performance.now() - started, 20)
    }
  }).timeout(4000)

  test('invalid email throws E_ACCOUNT_KIT_INVALID_INPUT', async ({ assert }) => {
    const recorder = makeNotify()
    const { account } = service({ notify: recorder.notify })
    for (const email of ['invalid', '@ab', 'ab@', '  @  ', 'a b@example.test'])
      await assert.rejects(
        () => account.passwordReset.request({ email, clientKey: 'first' }),
        E_ACCOUNT_KIT_INVALID_INPUT
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
        assert.instanceOf(error, E_ACCOUNT_KIT_INVALID_INPUT)
      }
    }
    // The address keeps its whole budget: five requests from separate clients all pass.
    for (let index = 0; index < 5; index++) {
      await account.passwordReset.request({
        email: 'person@example.test',
        clientKey: `client-${index}`,
      })
    }
  })
})
