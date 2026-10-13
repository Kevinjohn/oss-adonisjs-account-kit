import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { Encryption } from '@adonisjs/core/encryption'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import { DeliveryError, InvalidInputError, ThrottledError } from '../src/errors.js'
import type { AccountKitConfig } from '../src/types.js'
import { bootTestApp } from './helpers/app.js'
import { makeConfig, makeNotify, makeUsersAdapter } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'

test.group('verification.send', (group) => {
  let kit: Awaited<ReturnType<typeof bootTestApp>>
  let encryption: Encryption
  group.setup(async () => {
    kit = await bootTestApp()
    encryption = await kit.app.container.make(Encryption)
  })
  group.each.setup(async () => {
    await resetSchema(kit)
    await kit.limiter.clear()
  })
  group.teardown(async () => {
    await kit.close()
  })

  async function createUser(verified = false) {
    const [id] = await kit.db
      .table('users')
      .insert({
        email: 'person@example.test',
        password: await kit.hash.make('password123'),
        email_verified_at: verified ? DateTime.utc().toISO() : null,
        created_at: DateTime.utc().toISO(),
      })
      .returning('id')
    return typeof id === 'object' ? id.id : id
  }

  function service(overrides: Partial<Omit<AccountKitConfig, 'users'>> = {}) {
    const recorder = makeNotify()
    const config = defineConfig(
      makeConfig({
        users: makeUsersAdapter(kit.db, kit.hash),
        notify: recorder.notify,
        ...overrides,
      })
    )
    const account = new AccountKit({ config, db: kit.db, limiter: kit.limiter, encryption })
    return { account, recorder }
  }

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
    const token = new URL(url as string).pathname.split('/').at(-1)!
    assert.deepEqual(encryption.decrypt(token, 'account-kit:verify-email'), {
      userId: id,
      email: 'person@example.test',
    })
    assert.isNull(encryption.decrypt(token, 'wrong-purpose'))
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
