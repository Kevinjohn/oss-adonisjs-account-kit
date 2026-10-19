import { test } from '@japa/runner'
import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import { createLucidAdapter } from '../adapters/lucid.js'
import { transaction } from '../src/db.js'
import type { Trx, UsersAdapter } from '../src/types.js'
import type { AdapterContractFixture } from '../testing/adapter_contract.js'
import { assertUsersAdapterContract } from '../testing/adapter_contract.js'
import LucidUser from './fixtures/lucid_user.js'
import { useTestApp } from './helpers/app.js'
import { contractFixture as sharedContractFixture } from './helpers/adapter_contract_fixture.js'

test.group('maintained Lucid adapter', (group) => {
  const kit = useTestApp(group)

  group.setup(async () => {
    await kit.db.connection().schema.alterTable('users', (table) => {
      table.string('full_name').notNullable()
      table.string('role').nullable()
    })
  })

  group.each.setup(() => {
    LucidUser.hashCalls = 0
  })

  test('package locking passes the adapter contract when a valid adapter ignores forUpdate', async ({
    assert,
  }) => {
    const lucidAdapter = createLucidAdapter(async () => LucidUser, {
      mapRegistrationData(data, user) {
        const registration = data as { fullName?: unknown }
        if (typeof registration.fullName !== 'string') {
          throw new Error('fullName is required')
        }
        user.fullName = registration.fullName
      },
      verifyPassword: async (stored, password) => stored === `hashed:${password}`,
    })
    const adapter: UsersAdapter = {
      ...lucidAdapter,
      async findById(id, trx) {
        // Deliberately omit the legacy third argument; the package owns row locking.
        return lucidAdapter.findById(id, trx)
      },
    }
    const metadata = await lucidAdapter.resolveMetadata()
    assert.deepEqual(metadata, { table: 'users', primaryKey: 'id' })

    const contractFixture: AdapterContractFixture = sharedContractFixture(kit, adapter, {
      registrationData: { fullName: 'Contract User' },
    })

    await assertUsersAdapterContract(contractFixture)

    assert.equal(
      LucidUser.hashCalls,
      5,
      'each create, duplicate create, rolled-back create, and both setPassword calls hash once'
    )

    const brokenAdapter = (overrides: Partial<UsersAdapter>): UsersAdapter => ({
      ...adapter,
      ...overrides,
    })
    const rejectsBrokenAdapter = (broken: UsersAdapter, suffix: string) =>
      assert.rejects(() =>
        assertUsersAdapterContract({
          ...contractFixture,
          adapter: broken,
          emailPrefix: `broken-${suffix}-${Date.now()}`,
        })
      )

    const verificationShadows = new WeakMap<Trx, { id: number | string; at: DateTime }>()
    await rejectsBrokenAdapter(
      brokenAdapter({
        async markEmailVerified(id, at, trx) {
          verificationShadows.set(trx, { id, at })
        },
        async findById(id, trx) {
          const user = await adapter.findById(id, trx)
          const shadow = trx ? verificationShadows.get(trx) : undefined
          return user && shadow?.id === id ? { ...user, emailVerifiedAt: shadow.at } : user
        },
      }),
      'non-persisting-verification-setter'
    )
    await rejectsBrokenAdapter(brokenAdapter({ async setEmail() {} }), 'no-op-email-setter')
    await rejectsBrokenAdapter(
      brokenAdapter({
        async setEmail(id, email, trx) {
          await adapter.setEmail(id, email, trx)
          await trx.from('users').where('id', id).update({ email: email.trim().toUpperCase() })
        },
      }),
      'non-normalizing-email-setter'
    )
  })

  test('maps only trusted registration fields before controlled account fields', async ({
    assert,
  }) => {
    const adapter = createLucidAdapter(async () => LucidUser, {
      emailConstraint: 'users_account_email_unique',
      mapRegistrationData(data, user) {
        assert.isObject(data)
        const registration = data as { fullName?: unknown }
        if (typeof registration.fullName !== 'string') {
          throw new Error('fullName is required')
        }
        user.fullName = registration.fullName
      },
      verifyPassword: async (stored, password) => stored === `hashed:${password}`,
    })
    assert.deepEqual(await adapter.resolveMetadata(), {
      table: 'users',
      primaryKey: 'id',
      emailConstraint: 'users_account_email_unique',
    })

    const user = await transaction(kit.db, (trx) =>
      adapter.create(
        {
          email: '  Ada@Example.Test ',
          password: 'controlled-password',
          unverifiedEmail: null,
          registrationData: {
            fullName: 'Ada Lovelace',
            id: 900,
            email: 'attacker@example.test',
            password: 'untrusted-password',
            emailVerifiedAt: null,
          },
        },
        trx
      )
    )

    const row = await kit.db.from('users').where('id', user.id).first()
    assert.equal(user.email, 'ada@example.test')
    assert.equal(row.id, user.id)
    assert.equal(row.email, 'ada@example.test')
    assert.equal(row.password, 'hashed:controlled-password')
    assert.equal(row.full_name, 'Ada Lovelace')
    assert.isNull(user.emailVerifiedAt)
  })

  test('rejects registration data without an explicit trusted mapper', async ({ assert }) => {
    const adapter = createLucidAdapter(async () => LucidUser)
    await assert.rejects(
      () =>
        transaction(kit.db, (trx) =>
          adapter.create(
            {
              email: 'missing-mapper@example.test',
              password: 'password',
              unverifiedEmail: null,
              registrationData: { fullName: 'Grace Hopper' },
            },
            trx
          )
        ),
      /registrationData requires mapRegistrationData/
    )
    assert.isNull(await adapter.findByEmail('missing-mapper@example.test'))
  })

  test('rejects a registration mapper that assigns a package controlled role', async ({
    assert,
  }) => {
    const adapter = createLucidAdapter(async () => LucidUser, {
      mapRegistrationData(_data, user) {
        user.role = 'admin'
      },
    })

    await assert.rejects(
      () =>
        transaction(kit.db, (trx) =>
          adapter.create(
            {
              email: 'role-mapper@example.test',
              password: 'password',
              unverifiedEmail: null,
              registrationData: {},
            },
            trx
          )
        ),
      /cannot assign id, email, unverifiedEmail, password, emailVerifiedAt, or role/
    )
    assert.isNull(await adapter.findByEmail('role-mapper@example.test'))
  })

  test('profile mapping persists configured fields and rejects protected writes', async ({
    assert,
  }) => {
    const adapter = createLucidAdapter(async () => LucidUser, {
      mapRegistrationData(data, user) {
        user.fullName = (data as { fullName: string }).fullName
      },
    })
    const user = await transaction(kit.db, (trx) =>
      adapter.create(
        {
          email: 'profile@example.test',
          password: 'password123',
          unverifiedEmail: null,
          registrationData: { fullName: 'First Name' },
        },
        trx
      )
    )
    await transaction(kit.db, (trx) =>
      adapter.updateRegistrationData!(user.id, { fullName: 'New Name' }, trx)
    )
    let row = await kit.db.from('users').where('id', user.id).first()
    assert.equal(row.full_name, 'New Name')
    assert.equal(row.email, user.email)

    const unsafe = createLucidAdapter(async () => LucidUser, {
      mapRegistrationData(_data, model) {
        model.role = 'admin'
      },
    })
    await assert.rejects(
      () => transaction(kit.db, (trx) => unsafe.updateRegistrationData!(user.id, {}, trx)),
      /cannot assign id, email, unverifiedEmail, password, emailVerifiedAt, or role/
    )
    row = await kit.db.from('users').where('id', user.id).first()
    assert.equal(row.full_name, 'New Name')
    assert.isNull(row.role)
  })

  test('rejects named connections and physical primary keys other than id', async ({ assert }) => {
    class NamedConnectionUser extends LucidUser {
      static connection = 'tenant'
    }
    class AlternatePrimaryKeyUser extends LucidUser {
      static primaryKey = 'userId'
    }

    const namedConnectionAdapter = createLucidAdapter(async () => NamedConnectionUser)
    await assert.rejects(
      () => namedConnectionAdapter.resolveMetadata(),
      /must use the default database connection/
    )

    const alternatePrimaryKeyAdapter = createLucidAdapter(async () => AlternatePrimaryKeyUser)
    await assert.rejects(
      () => alternatePrimaryKeyAdapter.resolveMetadata(),
      /must use the id attribute mapped to the id column/
    )
  })

  test('diagnoses a user model whose pending email maps to an unsupported column', async ({
    assert,
  }) => {
    class AlternatePendingColumnUser extends LucidUser {
      @column({ columnName: 'pending_email' })
      declare unverifiedEmail: string | null
    }
    const adapter = createLucidAdapter(async () => AlternatePendingColumnUser)
    await assert.rejects(
      () => adapter.resolveMetadata(),
      /unverifiedEmail attribute mapped to the unverified_email column/
    )
  })
})

test.group('identity creation contract', (group) => {
  const kit = useTestApp(group)

  test('creates an inactive account with a pending email and no local password', async ({
    assert,
  }) => {
    const adapter = createLucidAdapter(async () => LucidUser)
    const user = await transaction(kit.db, (trx) =>
      adapter.create(
        {
          email: '  Pending@Example.Test ',
          unverifiedEmail: ' Pending@Example.Test ',
          password: null,
        },
        trx
      )
    )
    assert.equal(user.email, 'pending@example.test')
    assert.equal(user.unverifiedEmail, 'pending@example.test')
    assert.isFalse(user.hasPassword)
    assert.isNull(user.emailVerifiedAt)
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.equal(row.unverified_email, 'pending@example.test')
    assert.isNull(row.password)
  })
})
