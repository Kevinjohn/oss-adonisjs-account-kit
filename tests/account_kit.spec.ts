import { test } from '@japa/runner'
import { bootTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'
import { defineConfig } from '../src/account_kit.js'

test.group('account kit configuration and service surface', (group) => {
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

  test('fills defaults while preserving supplied callbacks and nested overrides', ({ assert }) => {
    const input = makeConfig({
      users: makeUsersAdapter(kit.db, kit.hash),
      ttl: { recovery: '2h' },
      throttle: { requests: 2 },
    })
    const resolved = defineConfig(input)
    assert.equal(resolved.users, input.users)
    assert.equal(resolved.authorize, input.authorize)
    assert.equal(resolved.notify, input.notify)
    assert.deepEqual(resolved.ttl, {
      recovery: '2h',
      verification: '1h',
      invitation: '7d',
      emailChange: '1h',
    })
    assert.deepEqual(resolved.throttle, { requests: 2, duration: '15m' })
    assert.equal(resolved.minRequestMs, 300)
    assert.deepEqual(input.ttl, { recovery: '2h' })
    assert.deepEqual(input.throttle, { requests: 2 })
  })

  test('rejects missing callbacks and invalid TTLs at configuration time', ({ assert }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    assert.throws(() =>
      defineConfig({ ...base, notify: { ...base.notify, recovery: null } } as never)
    )
    assert.throws(() => defineConfig({ ...base, users: { ...base.users, create: null } } as never))
    assert.throws(() => defineConfig({ ...base, ttl: { verification: 'soon' } }))
    assert.throws(() => defineConfig({ ...base, ttl: { invitation: '0s' } }))
    assert.throws(() => defineConfig({ ...base, ttl: { recovery: '1000000000d' } }))
  })

  test('rejects invalid recovery timing and throttle configuration', ({ assert }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    for (const minRequestMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      assert.throws(() => defineConfig({ ...base, minRequestMs }))
    }
    assert.equal(defineConfig({ ...base, minRequestMs: 0 }).minRequestMs, 0)

    for (const requests of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      assert.throws(() => defineConfig({ ...base, throttle: { requests } }))
    }
    for (const duration of ['soon', '0s', '1ms', '100000000d']) {
      assert.throws(() => defineConfig({ ...base, throttle: { duration } }))
    }
  })

  test('rejects a supplied non-function credential callback', ({ assert }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    assert.throws(() => defineConfig({ ...base, onCredentialsChanged: 'not a callback' } as never))
  })

  test('uses defaults when nested optional values are explicitly undefined', ({ assert }) => {
    const input = makeConfig({
      users: makeUsersAdapter(kit.db, kit.hash),
      ttl: {
        recovery: undefined,
        verification: undefined,
        invitation: undefined,
        emailChange: undefined,
      },
      throttle: { requests: undefined, duration: undefined },
    })
    const resolved = defineConfig(input)
    assert.deepEqual(resolved.ttl, {
      recovery: '1h',
      verification: '1h',
      invitation: '7d',
      emailChange: '1h',
    })
    assert.deepEqual(resolved.throttle, { requests: 5, duration: '15m' })
  })
})
