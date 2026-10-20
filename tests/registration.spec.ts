/* eslint-disable @unicorn/no-await-expression-member -- Inspect database results directly in focused registration assertions. */
import { test } from '@japa/runner'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import {
  CapabilityDisabledError,
  DeliveryError,
  RegistrationEmailAlreadyRegisteredError,
  InvalidInputError,
} from '../src/errors.js'
import { useTestApp } from './helpers/app.js'
import {
  insertUser,
  makeConfig,
  makeService,
  makeUsersAdapter,
  tokenFrom,
} from './helpers/fakes.js'

test.group('registration', (group) => {
  const kit = useTestApp(group)

  test('normalizes email, maps only trusted fields, and creates an inactive password account', async ({
    assert,
  }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const created: unknown[] = []
    const config = defineConfig(
      makeConfig({
        users: {
          ...users,
          async create(attrs, trx) {
            created.push(attrs)
            return users.create(attrs, trx)
          },
        },
        enabled: ['registration', 'emailVerification'],
        registration: {
          availability: 'open',
          mapFields: async (input) => ({ displayName: (input as { name: string }).name }),
        },
      })
    )
    const account = new AccountKit({
      config,
      db: kit.db,
      encryption: kit.encryption,
      limiter: kit.limiter,
    })
    const user = await account.registration.register({
      email: '  PERSON@Example.Test ',
      password: 'password123',
      registrationData: { name: 'Pat', role: 'admin' },
    })
    assert.equal(user.email, 'person@example.test')
    assert.equal(user.unverifiedEmail, user.email)
    assert.isNull(user.emailVerifiedAt)
    assert.isTrue(user.hasPassword)
    assert.deepEqual((created[0] as { registrationData: unknown }).registrationData, {
      displayName: 'Pat',
    })
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.equal(row.unverified_email, row.email)
    assert.isNull(row.email_verified_at)
  })

  test('rejects untrusted fields and protected mapping outputs before creating a user', async ({
    assert,
  }) => {
    const service = makeService(kit, {
      enabled: ['registration'],
      registration: { availability: 'open' },
    })
    await assert.rejects(
      () =>
        service.account.registration.register({
          email: 'person@example.test',
          password: 'password123',
          registrationData: { role: 'admin' },
        }),
      InvalidInputError
    )
    const mapped = makeService(kit, {
      enabled: ['registration'],
      registration: { availability: 'open', mapFields: async () => ({ role: 'admin' }) },
    })
    await assert.rejects(
      () =>
        mapped.account.registration.register({
          email: 'person@example.test',
          password: 'password123',
          registrationData: {},
        }),
      InvalidInputError
    )
    assert.equal((await kit.db.from('users')).length, 0)
  })

  test('runs required-field mapping when registrationData is omitted', async ({ assert }) => {
    const required = makeService(kit, {
      enabled: ['registration'],
      registration: {
        availability: 'open',
        mapFields: async (input) => {
          if (!input) throw new InvalidInputError('Profile is required')
          return input as Record<string, unknown>
        },
      },
    })
    await assert.rejects(
      () =>
        required.account.registration.register({
          email: 'missing@example.test',
          password: 'password123',
        }),
      InvalidInputError
    )
    assert.lengthOf(await kit.db.from('users'), 0)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
  })

  test('rejects object instances returned by registration mapping', async ({ assert }) => {
    const instance = makeService(kit, {
      enabled: ['registration'],
      registration: { availability: 'open', mapFields: async () => new Date() as never },
    })
    await assert.rejects(
      () =>
        instance.account.registration.register({
          email: 'instance@example.test',
          password: 'password123',
          registrationData: {},
        }),
      InvalidInputError
    )
    assert.lengthOf(await kit.db.from('users'), 0)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
  })

  test('enforces closed availability and disabled capability without writing', async ({
    assert,
  }) => {
    const closed = makeService(kit, {
      enabled: ['registration'],
      registration: { availability: 'closed' },
    })
    await assert.rejects(
      () =>
        closed.account.registration.register({
          email: 'person@example.test',
          password: 'password123',
        }),
      CapabilityDisabledError
    )
    const disabled = makeService(kit, {
      enabled: ['emailVerification'],
      registration: { availability: 'open' },
    })
    await assert.rejects(
      () =>
        disabled.account.registration.register({
          email: 'person@example.test',
          password: 'password123',
        }),
      CapabilityDisabledError
    )
    assert.equal((await kit.db.from('users')).length, 0)
  })

  test('requires explicit availability when enabled and permits application-owned admission', async ({
    assert,
  }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    assert.throws(
      () => defineConfig(makeConfig({ users, enabled: ['registration'], registration: undefined })),
      'registration.availability must be open, closed, or application'
    )
    assert.throws(
      () => defineConfig(makeConfig({ users, registration: undefined })),
      'registration.availability must be open, closed, or application'
    )
    const service = makeService(kit, {
      enabled: ['registration'],
      registration: { availability: 'application' },
    })
    const user = await service.account.registration.register({
      email: 'approved@example.test',
      password: 'password123',
    })
    assert.equal(user.email, 'approved@example.test')
  })

  test('rolls back account creation when its transaction fails', async ({ assert }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const service = makeService(kit, {
      enabled: ['registration'],
      registration: { availability: 'open' },
      users: {
        ...users,
        async create(attrs, trx) {
          await users.create(attrs, trx)
          throw new Error('injected transaction failure')
        },
      },
    })
    await assert.rejects(
      () =>
        service.account.registration.register({
          email: 'rollback@example.test',
          password: 'password123',
        }),
      'injected transaction failure'
    )
    assert.lengthOf(await kit.db.from('users'), 0)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
    assert.lengthOf(service.recorder.calls, 0)
  })

  test('reports every existing account state with the same email field error', async ({
    assert,
  }) => {
    const service = makeService(kit, {
      enabled: ['registration'],
      registration: { availability: 'open' },
    })
    await service.account.registration.register({
      email: 'person@example.test',
      password: 'password123',
    })
    for (const state of [
      { password: 'password123', pending: null },
      { password: null, pending: null },
      { password: null, pending: 'person@example.test' },
    ]) {
      await kit.db
        .from('users')
        .where('email', 'person@example.test')
        .update({ password: state.password, unverified_email: state.pending })
      await assert.rejects(
        () =>
          service.account.registration.register({
            email: 'PERSON@example.test',
            password: 'password123',
          }),
        RegistrationEmailAlreadyRegisteredError
      )
    }
    assert.equal((await kit.db.from('users')).length, 1)
    assert.equal(RegistrationEmailAlreadyRegisteredError.status, 422)
  })

  test('maps a database uniqueness race after an empty email precheck', async ({ assert }) => {
    const first = makeService(kit, {
      enabled: ['registration'],
      registration: { availability: 'open' },
    })
    await first.account.registration.register({
      email: 'race@example.test',
      password: 'password123',
    })
    const users = makeUsersAdapter(kit.db, kit.hash)
    const racing = makeService(kit, {
      enabled: ['registration'],
      registration: { availability: 'open' },
      users: { ...users, findByEmail: async () => null },
    })
    await assert.rejects(
      () =>
        racing.account.registration.register({
          email: 'RACE@example.test',
          password: 'password123',
        }),
      RegistrationEmailAlreadyRegisteredError
    )
    assert.lengthOf(await kit.db.from('users'), 1)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 1)
    assert.lengthOf(racing.recorder.calls, 0)
  })

  test('concurrent requests create one account and one verification delivery', async ({
    assert,
  }) => {
    const service = makeService(kit, {
      enabled: ['registration', 'emailVerification'],
      registration: { availability: 'open' },
    })
    const results = await Promise.allSettled([
      service.account.registration.register({
        email: 'same@example.test',
        password: 'password123',
      }),
      service.account.registration.register({
        email: ' SAME@example.test ',
        password: 'password123',
      }),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(
      results.filter(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof RegistrationEmailAlreadyRegisteredError
      ).length,
      1
    )
    assert.equal((await kit.db.from('users')).length, 1)
    assert.equal((await kit.db.from('email_verification_tokens')).length, 1)
    assert.equal(
      service.recorder.calls.filter((call) => call.method === 'accountActivationProvision').length,
      1
    )
  })

  test('delivery failure leaves account and proof committed for resend', async ({ assert }) => {
    const service = makeService(kit, {
      enabled: ['registration', 'emailVerification'],
      registration: { availability: 'open' },
    })
    service.recorder.failOn('accountActivationProvision')
    await assert.rejects(
      () =>
        service.account.registration.register({
          email: 'person@example.test',
          password: 'password123',
        }),
      DeliveryError
    )
    const row = await kit.db.from('users').where('email', 'person@example.test').first()
    assert.exists(row)
    assert.equal((await kit.db.from('email_verification_tokens')).length, 1)
    service.recorder.failOn(null)
    assert.equal(await service.account.emailVerification.send({ userId: row.id }), 'sent')
    assert.equal(tokenFrom(service.recorder.calls.at(-1)?.args[1]).length > 0, true)
  })

  test('new-password policy rejects weak registration while defaults accept the service bounds', async ({
    assert,
  }) => {
    const service = makeService(kit, {
      enabled: ['registration'],
      registration: { availability: 'open' },
      passwordPolicy: { mixedCase: true, numbers: true, minScore: 3 },
    })
    await assert.rejects(
      () =>
        service.account.registration.register({
          email: 'person@example.test',
          password: 'password123',
        }),
      InvalidInputError
    )
    const user = await service.account.registration.register({
      email: 'person@example.test',
      password: 'LongerPassword12345',
    })
    assert.equal(user.email, 'person@example.test')
  })

  test('login accepts a previously valid password under a stricter new-password policy', async ({
    assert,
  }) => {
    const user = await insertUser(kit, { password: 'lowercase123' })
    const service = makeService(kit, {
      enabled: ['registration'],
      registration: { availability: 'open' },
      passwordPolicy: { mixedCase: true, symbols: true },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const result = await service.account.authentication.login(
      { email: user.email, password: 'lowercase123', clientKey: 'policy-client' },
      {
        strategy: 'session',
        name: 'web',
        establish: async () => 'session',
        terminate: async () => {},
      }
    )
    assert.equal(result.account.id, user.id)
    await assert.rejects(() =>
      service.account.registration.register({
        email: 'new@example.test',
        password: 'lowercase123',
      })
    )
  })
})
