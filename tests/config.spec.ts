import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { defineConfig } from '../src/account_kit.js'
import { expiresAt } from '../src/ttl.js'
import type { AccountKitConfig } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'
test.group('account kit configuration and service surface', (group) => {
  const kit = useTestApp(group)

  test('fills defaults while preserving supplied callbacks and nested overrides', ({ assert }) => {
    const input = makeConfig({
      users: makeUsersAdapter(kit.db, kit.hash),
      expiresIn: { passwordReset: '2h' },
      throttle: { requests: 2 },
    })
    const resolved = defineConfig(input)
    assert.equal(resolved.users, input.users)
    assert.deepEqual(resolved.authorize, input.authorize)
    assert.deepEqual(resolved.notify, input.notify)
    assert.deepEqual(resolved.expiresIn, {
      passwordReset: '2h',
      emailVerification: '1h',
      invitation: '7d',
      emailChange: '1h',
      magicLink: '15m',
    })
    assert.deepEqual(resolved.throttle, { requests: 2, duration: '15m' })
    assert.equal(resolved.minRequestMs, 300)
    assert.equal(resolved.tokenSecretLength, 40)
    assert.deepEqual(input.expiresIn, { passwordReset: '2h' })
    assert.deepEqual(input.throttle, { requests: 2 })
  })

  test('omitted enabled capabilities leave registration and invitations disabled', ({ assert }) => {
    const input = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash), enabled: undefined })
    const resolved = defineConfig(input)
    assert.notInclude(resolved.enabled, 'registration')
    assert.notInclude(resolved.enabled, 'invitations')
  })

  test('registration availability is required in the public configuration type', ({ assert }) => {
    type AllowsOmission =
      Omit<AccountKitConfig, 'registration'> extends AccountKitConfig ? true : false
    const allowsOmission: AllowsOmission = false
    assert.isFalse(allowsOmission)
  })

  test('accepts token secret length boundaries and rejects invalid values', ({ assert }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    for (const length of [16, 64])
      assert.equal(defineConfig({ ...base, tokenSecretLength: length }).tokenSecretLength, length)
    for (const length of [0, 15, 65, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -1])
      assert.throws(
        () => defineConfig({ ...base, tokenSecretLength: length }),
        /tokenSecretLength must be an integer from 16 to 64/
      )
  })

  test('rejects missing callbacks and invalid TTLs at configuration time', ({ assert }) => {
    const base = makeConfig({
      users: makeUsersAdapter(kit.db, kit.hash),
      enabled: ['passwordReset', 'emailVerification', 'invitations', 'emailPasswordManagement'],
    })
    assert.throws(() =>
      defineConfig({ ...base, notify: { ...base.notify, passwordResetProvision: null } } as never)
    )
    assert.throws(() => defineConfig({ ...base, users: { ...base.users, create: null } } as never))
    assert.throws(() => defineConfig({ ...base, expiresIn: { emailVerification: 'soon' } }))
    assert.throws(() => defineConfig({ ...base, expiresIn: { invitation: '0s' } }))
    assert.throws(() => defineConfig({ ...base, expiresIn: { passwordReset: '1000000000d' } }))
    for (const seconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => defineConfig({ ...base, expiresIn: { passwordReset: seconds } }))
    }
  })

  test('accepts numeric seconds with the same expiration as a duration string', ({ assert }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    const duration = defineConfig({ ...base, expiresIn: { passwordReset: '1h' } })
    const seconds = defineConfig({ ...base, expiresIn: { passwordReset: 3600 } })
    const now = DateTime.utc(2026, 1, 2, 3, 4, 5)
    assert.equal(
      expiresAt(now, duration.expiresIn.passwordReset).toMillis(),
      expiresAt(now, seconds.expiresIn.passwordReset).toMillis()
    )
  })

  test('rejects invalid password reset timing and throttle configuration', ({ assert }) => {
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

  test('defaults usersTable to users and rejects non-identifier names', ({ assert }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    assert.equal(defineConfig(base).usersTable, 'users')
    assert.equal(defineConfig({ ...base, usersTable: 'accounts' }).usersTable, 'accounts')
    for (const usersTable of ['', 'users; drop table users', '1users', 'app.users']) {
      assert.throws(() => defineConfig({ ...base, usersTable }))
    }
  })

  test('rejects a supplied non-function credential callback', ({ assert }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    assert.throws(() => defineConfig({ ...base, onCredentialsChanged: 'not a callback' } as never))
  })

  test('uses defaults when nested optional values are explicitly undefined', ({ assert }) => {
    const input = makeConfig({
      users: makeUsersAdapter(kit.db, kit.hash),
      expiresIn: {
        passwordReset: undefined,
        emailVerification: undefined,
        invitation: undefined,
        emailChange: undefined,
      },
      throttle: { requests: undefined, duration: undefined },
    })
    const resolved = defineConfig(input)
    assert.deepEqual(resolved.expiresIn, {
      passwordReset: '1h',
      emailVerification: '1h',
      invitation: '7d',
      emailChange: '1h',
      magicLink: '15m',
    })
    assert.deepEqual(resolved.throttle, { requests: 5, duration: '15m' })
  })
})
