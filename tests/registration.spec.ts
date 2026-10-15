/* eslint-disable @unicorn/no-await-expression-member -- Inspect database results directly in focused registration assertions. */
import { test } from '@japa/runner'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import {
  CapabilityDisabledError,
  DeliveryError,
  RegistrationEmailAlreadyRegisteredError,
  UnverifiedEmailError,
  InvalidInputError,
} from '../src/errors.js'
import { useTestApp } from './helpers/app.js'
import { makeConfig, makeService, makeUsersAdapter, tokenFrom } from './helpers/fakes.js'

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
      password: 'Password123',
    })
    assert.equal(user.email, 'person@example.test')
  })

  test('a claimant replaces the precreator password before activation and revokes earlier credentials', async ({
    assert,
  }) => {
    const calls: string[] = []
    const service = makeService(kit, {
      enabled: ['registration', 'emailVerification'],
      registration: { availability: 'open' },
      onCredentialsChangedTransaction: async (user, context, trx) => {
        const row = await trx.from('users').where('id', user.id).first()
        assert.isNull(row.unverified_email)
        assert.equal(context.operation, 'registration_claim')
        calls.push('revoke')
      },
    })
    const user = await service.account.registration.register({
      email: 'victim@example.test',
      password: 'attackerPassword123',
    })
    const token = tokenFrom(service.recorder.calls[0].args[1])
    await assert.rejects(
      () => service.account.emailVerification.complete({ token } as never),
      InvalidInputError
    )
    assert.equal((await kit.db.from('email_verification_tokens')).length, 1)
    await service.account.emailVerification.complete({ token, password: 'VictimPassword123' })
    assert.deepEqual(calls, ['revoke'])
    const trx = await kit.db.transaction()
    try {
      assert.isFalse(await service.users.verifyPassword(user.id, 'attackerPassword123', trx))
      assert.isTrue(await service.users.verifyPassword(user.id, 'VictimPassword123', trx))
    } finally {
      await trx.rollback()
    }
  })

  test('issuance and claim serialize so an in-flight old-password credential cannot survive', async ({
    assert,
  }) => {
    await kit.db.connection().schema.createTable('issued_credentials', (table) => {
      table.increments('id')
      table.integer('user_id').notNullable()
    })
    try {
      let releaseIssuance!: () => void
      let issuanceStarted!: () => void
      const waitForIssuance = new Promise<void>((resolve) => {
        issuanceStarted = resolve
      })
      const holdIssuance = new Promise<void>((resolve) => {
        releaseIssuance = resolve
      })
      const service = makeService(kit, {
        enabled: ['registration', 'emailVerification'],
        registration: { availability: 'open' },
        onCredentialsChangedTransaction: async (user, _context, trx) => {
          await trx.from('issued_credentials').where('user_id', user.id).delete()
        },
      })
      await service.account.registration.register({
        email: 'victim@example.test',
        password: 'attackerPassword123',
      })
      const token = tokenFrom(service.recorder.calls[0].args[1])
      const issuing = service.account.registration.issueCredential({
        email: 'victim@example.test',
        password: 'attackerPassword123',
        issue: async (user, trx) => {
          await trx.table('issued_credentials').insert({ user_id: user.id })
          issuanceStarted()
          await holdIssuance
          return 'limited'
        },
      })
      await waitForIssuance
      const claiming = service.account.emailVerification.complete({
        token,
        password: 'VictimPassword123',
      })
      releaseIssuance()
      assert.equal((await issuing).credential, 'limited')
      await claiming
      assert.lengthOf(await kit.db.from('issued_credentials'), 0)
      await assert.rejects(
        () =>
          service.account.registration.issueCredential({
            email: 'victim@example.test',
            password: 'attackerPassword123',
            issue: async (user, trx) =>
              trx.table('issued_credentials').insert({ user_id: user.id }),
          }),
        InvalidInputError
      )
      assert.lengthOf(await kit.db.from('issued_credentials'), 0)
    } finally {
      await kit.db.connection().schema.dropTable('issued_credentials')
    }
  })

  test('limited credentials reach only allowed actions until verification, and restrictions deny access', async ({
    assert,
  }) => {
    let allowed = true
    const service = makeService(kit, {
      enabled: ['registration', 'emailVerification'],
      registration: { availability: 'open', allowAccess: () => allowed },
    })
    const user = await service.account.registration.register({
      email: 'person@example.test',
      password: 'password123',
    })
    const token = tokenFrom(service.recorder.calls[0].args[1])
    const issued = await service.account.registration.issueCredential({
      email: user.email,
      password: 'password123',
      issue: async () => 'limited-token',
    })
    assert.equal(issued.credential, 'limited-token')
    assert.equal(issued.user.unverifiedEmail, user.email)
    await assert.rejects(
      () => service.account.registration.requireVerified(user.id),
      UnverifiedEmailError
    )
    allowed = false
    await assert.rejects(() =>
      service.account.registration.issueCredential({
        email: user.email,
        password: 'password123',
        issue: async () => 'denied',
      })
    )
    await assert.rejects(() => service.account.registration.requireVerified(user.id))
    allowed = true
    await service.account.emailVerification.complete({ token, password: 'Password123' })
    assert.isNull((await service.account.registration.requireVerified(user.id)).unverifiedEmail)
  })
})
