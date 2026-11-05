import { AssertionError } from 'node:assert'
import { test } from '@japa/runner'
import { column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'
import { createLucidAdapter } from '../adapters/lucid.js'
import {
  InvalidConfigurationError,
  RegistrationEmailAlreadyRegisteredError,
} from '../src/errors.js'
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
      6,
      'each create, duplicate create, rolled-back create, re-create after delete, and both setPassword calls hash once'
    )

    const brokenAdapter = (overrides: Partial<UsersAdapter>): UsersAdapter => ({
      ...adapter,
      ...overrides,
    })
    const rejectsBrokenAdapter = (broken: UsersAdapter, suffix: string) =>
      assert.rejects(
        () =>
          assertUsersAdapterContract({
            ...contractFixture,
            adapter: broken,
            emailPrefix: `broken-${suffix}-${Date.now()}`,
          }),
        AssertionError
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
    // An adapter that checks for the address itself and throws the package's error conforms.
    await assertUsersAdapterContract({
      ...contractFixture,
      adapter: brokenAdapter({
        async create(attributes, trx) {
          if (await adapter.findByEmail(attributes.email, trx))
            throw new RegistrationEmailAlreadyRegisteredError()
          return adapter.create(attributes, trx)
        },
      }),
      emailPrefix: `prechecked-${Date.now()}`,
    })
  })

  test('physically deletes plain models and ignores missing users', async ({ assert }) => {
    const user = await LucidUser.create({
      email: 'plain-delete@example.test',
      password: null,
      unverifiedEmail: null,
      emailVerifiedAt: null,
      fullName: 'Plain User',
    })
    const adapter = createLucidAdapter(async () => LucidUser)
    await transaction(kit.db, (trx) => adapter.delete!(user.id, trx))
    assert.isNull(await kit.db.from('users').where('id', user.id).first())
    await transaction(kit.db, (trx) => adapter.delete!(user.id, trx))
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

  test('rejects a registration mapper that assigns a package controlled column', async ({
    assert,
  }) => {
    const assignments: Array<(user: Record<string, unknown>) => void> = [
      (user) => {
        user.role = 'admin'
      },
      (user) => {
        user.credentialsChangedAt = DateTime.utc()
      },
    ]
    for (const [index, assign] of assignments.entries()) {
      const adapter = createLucidAdapter(async () => LucidUser, {
        mapRegistrationData(_data, user) {
          assign(user as unknown as Record<string, unknown>)
        },
      })
      const email = `role-mapper-${index}@example.test`
      await assert.rejects(
        () =>
          transaction(kit.db, (trx) =>
            adapter.create(
              { email, password: 'password', unverifiedEmail: null, registrationData: {} },
              trx
            )
          ),
        /cannot assign id, email, unverifiedEmail, password, emailVerifiedAt, credentialsChangedAt, or role/
      )
      assert.isNull(await adapter.findByEmail(email))
    }
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
      /cannot assign id, email, unverifiedEmail, password, emailVerifiedAt, credentialsChangedAt, or role/
    )
    row = await kit.db.from('users').where('id', user.id).first()
    assert.equal(row.full_name, 'New Name')
    assert.isNull(row.role)
  })

  test('loader, model boot and application callback failures preserve their identities', async ({
    assert,
  }) => {
    const loaderFault = new Error('Lucid model loader failed')
    let loads = 0
    const lazy = createLucidAdapter(async () => {
      loads++
      throw loaderFault
    })
    assert.equal(loads, 0)
    assert.strictEqual(await lazy.resolveMetadata().catch((caught: unknown) => caught), loaderFault)
    assert.equal(loads, 1)
    const bootFault = new Error('Lucid model boot failed')
    class BrokenBootUser extends LucidUser {
      static boot() {
        throw bootFault
      }
    }
    const broken = createLucidAdapter(async () => BrokenBootUser)
    assert.strictEqual(await broken.resolveMetadata().catch((caught: unknown) => caught), bootFault)
    const mapperFault = new Error('Lucid registration mapper failed')
    const mapped = createLucidAdapter(async () => LucidUser, {
      mapRegistrationData: () => {
        throw mapperFault
      },
    })
    const error = await transaction(kit.db, (trx) =>
      mapped.create(
        {
          email: 'callback-fault@example.test',
          password: null,
          unverifiedEmail: null,
          registrationData: {},
        },
        trx
      )
    ).catch((caught: unknown) => caught)
    assert.strictEqual(error, mapperFault)
  })

  test('rejects named connections and physical primary keys other than id', async ({ assert }) => {
    class NamedConnectionUser extends LucidUser {
      static connection = 'tenant'
    }
    class AlternatePrimaryKeyUser extends LucidUser {
      static primaryKey = 'userId'
    }

    class MissingTableUser extends LucidUser {
      static boot() {
        super.boot()
        this.table = ''
      }
    }
    for (const [Model, field, message] of [
      [
        NamedConnectionUser,
        'model.connection',
        'account_kit: Lucid user models must use the default database connection',
      ],
      [
        AlternatePrimaryKeyUser,
        'model.primaryKey',
        'account_kit: Lucid user models must use the id attribute mapped to the id column',
      ],
      [MissingTableUser, 'model.table', 'account_kit: Lucid user model must define a table'],
    ] as const) {
      let loaded = false
      const adapter = createLucidAdapter(async () => {
        loaded = true
        return Model
      })
      assert.isFalse(loaded)
      const error = await adapter.resolveMetadata().catch((caught: unknown) => caught)
      assert.isTrue(loaded)
      assert.instanceOf(error, InvalidConfigurationError)
      assert.equal((error as InvalidConfigurationError).code, 'E_ACCOUNT_KIT_INVALID_CONFIGURATION')
      assert.equal((error as InvalidConfigurationError).field, field)
      assert.equal((error as Error).message, message)
      assert.isUndefined((error as Error).cause)
    }
  })

  test('diagnoses a user model whose pending email maps to an unsupported column', async ({
    assert,
  }) => {
    class AlternatePendingColumnUser extends LucidUser {
      @column({ columnName: 'pending_email' })
      declare unverifiedEmail: string | null
    }
    const adapter = createLucidAdapter(async () => AlternatePendingColumnUser)
    const error = await adapter.resolveMetadata().catch((caught: unknown) => caught)
    assert.instanceOf(error, InvalidConfigurationError)
    assert.equal((error as InvalidConfigurationError).code, 'E_ACCOUNT_KIT_INVALID_CONFIGURATION')
    assert.equal((error as InvalidConfigurationError).field, 'model.columns.unverifiedEmail')
    assert.equal(
      (error as Error).message,
      'account_kit: Lucid user models must use the unverifiedEmail attribute mapped to the unverified_email column'
    )
    assert.isUndefined((error as Error).cause)
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

  test('hashes and verifies with the model withAuthFinder hasher', async ({ assert }) => {
    class FinderUser extends LucidUser {
      static table = 'users'
    }
    Object.assign(FinderUser, {
      hashPassword: async (row: { password: string }) => {
        row.password = `finder:${row.password}`
      },
      findForAuth: () => null,
      verifyCredentials: () => null,
    })
    Object.assign(FinderUser.prototype, {
      async verifyPassword(this: LucidUser, plain: string) {
        return this.password === `finder:${plain}`
      },
    })
    const adapter = createLucidAdapter(async () => FinderUser)
    const hashed = await adapter.hashPassword!('finder-password')
    assert.equal(hashed, 'finder:finder-password')
    const user = await transaction(kit.db, (trx) =>
      adapter.create({ email: 'finder@example.test', unverifiedEmail: null, password: null }, trx)
    )
    await transaction(kit.db, (trx) => adapter.setPasswordHash!(user.id, hashed, trx))
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.equal(row.password, 'finder:finder-password')
    await transaction(kit.db, async (trx) => {
      assert.isTrue(await adapter.verifyPassword(user.id, 'finder-password', trx))
      assert.isFalse(await adapter.verifyPassword(user.id, 'other-password', trx))
    })
  })

  test('a verification time round-trips outside UTC', async ({ assert }) => {
    const previous = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const adapter = createLucidAdapter(async () => LucidUser)
      const user = await transaction(kit.db, (trx) =>
        adapter.create({ email: 'zone@example.test', unverifiedEmail: null, password: null }, trx)
      )
      const at = DateTime.utc(2026, 7, 1, 10, 0, 0)
      await transaction(kit.db, (trx) => adapter.markEmailVerified(user.id, at, trx))
      const read = await adapter.findById(user.id)
      assert.equal(read?.emailVerifiedAt?.toMillis(), at.toMillis())
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })
})
