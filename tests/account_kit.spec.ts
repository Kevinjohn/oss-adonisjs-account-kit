import { test } from '@japa/runner'
import { bootTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'
import { AccountKit, defineConfig } from '../src/account_kit.js'

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

  test('exposes all operation placeholders with the public input shapes', async ({ assert }) => {
    const config = defineConfig(makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) }))
    const service = new AccountKit({
      config,
      db: kit.db,
      encryption: null as never,
      limiter: kit.limiter,
    })
    const cases: Array<() => Promise<unknown>> = [
      () => service.recovery.reset({ token: 'token', password: 'password123' }),
      () => service.verification.send({ userId: 1 }),
      () => service.verification.complete({ token: 'token' }),
      () => service.invitations.send({ actorId: 1, email: 'a@example.test', role: 'user' }),
      () => service.invitations.list({ actorId: 1 }),
      () => service.invitations.inspect({ token: 'token' }),
      () => service.invitations.accept({ token: 'token', password: 'password123' }),
      () => service.invitations.resend({ actorId: 1, invitationId: 1 }),
      () => service.invitations.revoke({ actorId: 1, invitationId: 1 }),
      () =>
        service.credentials.changePassword({
          actorId: 1,
          currentPassword: 'old',
          newPassword: 'new',
        }),
      () =>
        service.credentials.requestEmailChange({
          actorId: 1,
          currentPassword: 'old',
          newEmail: 'b@example.test',
        }),
      () => service.credentials.completeEmailChange({ token: 'token' }),
    ]
    assert.lengthOf(cases, 12)
    for (const invoke of cases) await assert.rejects(invoke, 'not implemented')
  })
})
