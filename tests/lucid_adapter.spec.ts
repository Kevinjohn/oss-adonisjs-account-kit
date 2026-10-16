import { test } from '@japa/runner'
import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import { createLucidAdapter } from '../adapters/lucid.js'
import { defineConfig } from '../src/config.js'
import { lockUser, transaction } from '../src/db.js'
import type { Trx, UsersAdapter } from '../src/types.js'
import type { AdapterContractFixture } from '../testing/adapter_contract.js'
import { assertUsersAdapterContract } from '../testing/adapter_contract.js'
import LucidUser from './fixtures/lucid_user.js'
import { useTestApp } from './helpers/app.js'

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
    const packageConfig = defineConfig({
      users: adapter,
      enabled: [],
      urls: {},
      notify: {},
      limiterSecret: 'contract-limiter-secret-with-more-than-32-bytes',
    })
    const metadata = await lucidAdapter.resolveMetadata()
    assert.deepEqual(metadata, { table: 'users', primaryKey: 'id' })

    const contractFixture: AdapterContractFixture = {
      adapter,
      registrationData: { fullName: 'Contract User' },
      transaction: (callback) => transaction(kit.db, callback),
      acquireAccountLock: (id, trx) => lockUser(trx, packageConfig, id),
      async storedPassword(id) {
        const row = await kit.db.from('users').select('password').where('id', id).first()
        return row?.password ?? null
      },
      verifyPassword: async (stored, password) => stored === `hashed:${password}`,
      async assertLockBlocksWriter(id, acquireLock) {
        let locked!: () => void
        let release!: () => void
        const lockReady = new Promise<void>((resolve) => (locked = resolve))
        const holdLock = new Promise<void>((resolve) => (release = resolve))
        const lockTransaction = transaction(kit.db, async (trx) => {
          await acquireLock(trx)
          locked()
          await holdLock
        })
        await lockReady

        let writerSettled = false
        let writerError: unknown
        const writerTransaction = transaction(kit.db, async (trx) => {
          await trx.from('users').where('id', id).update({ email: 'lock-probe@example.test' })
          throw new Error('rollback lock probe')
        }).then(
          () => {
            writerSettled = true
          },
          (error: unknown) => {
            writerError = error
            writerSettled = true
          }
        )

        try {
          await new Promise((resolve) => setTimeout(resolve, 75))
          assert.isFalse(writerSettled, 'an independent writer must wait for the user lock')
        } finally {
          release()
        }
        await lockTransaction
        await writerTransaction
        assert.match(String(writerError), /rollback lock probe/)
      },
    }

    await assertUsersAdapterContract(contractFixture)

    assert.equal(
      LucidUser.hashCalls,
      3,
      'successful create, duplicate create attempt, and setPassword each run the model hook once'
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
