import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { createSqlUsersAdapter, type SqlUsersAdapterOptions } from '../adapters/sql.js'
import { transaction } from '../src/db.js'
import { assertUsersAdapterContract } from '../testing/adapter_contract.js'
import { useTestApp } from './helpers/app.js'
import { createAppUsersTable } from './helpers/app_users_table.js'
import { contractFixture, fakeHash } from './helpers/adapter_contract_fixture.js'

const fullName = (data: unknown) => {
  const name = (data as { fullName?: unknown }).fullName
  if (typeof name !== 'string') throw new Error('fullName is required')
  return { full_name: name }
}

test.group('SQL users adapter', (group) => {
  const kit = useTestApp(group)
  group.each.setup(async () => {
    await createAppUsersTable(kit, 'app_users')
    await createAppUsersTable(kit, 'app_string_users', { stringIds: true })
  })

  const adapter = (options: Partial<SqlUsersAdapterOptions> = {}) =>
    createSqlUsersAdapter({
      table: 'app_users',
      db: kit.db,
      ...fakeHash,
      mapRegistrationData: fullName,
      ...options,
    })
  const fullNameOf = async (table: string, id: number | string) => {
    const row = await kit.db.from(table).select('full_name').where('id', id).first()
    return row?.full_name ?? null
  }

  test('passes the adapter contract with integer ids', async () => {
    await assertUsersAdapterContract(
      contractFixture(kit, adapter(), {
        table: 'app_users',
        registrationData: { fullName: 'Contract User' },
        registrationUpdate: {
          data: { fullName: 'Renamed User' },
          read: (id) => fullNameOf('app_users', id),
          expected: 'Renamed User',
        },
      })
    )
  })

  test('passes the adapter contract with generated string ids', async () => {
    await assertUsersAdapterContract(
      contractFixture(kit, adapter({ table: 'app_string_users', generateId: randomUUID }), {
        table: 'app_string_users',
        stringIds: true,
        registrationData: { fullName: 'String User' },
      })
    )
  })

  test('registration columns cannot set identity, credential, verification or role columns', async ({
    assert,
  }) => {
    const create = (columns: Record<string, unknown>) =>
      transaction(kit.db, (trx) =>
        adapter({ mapRegistrationData: () => columns }).create(
          {
            email: 'a@example.test',
            password: 'password',
            unverifiedEmail: null,
            registrationData: {},
          },
          trx
        )
      )
    const update = (columns: Record<string, unknown>) =>
      transaction(kit.db, (trx) =>
        adapter({ mapRegistrationData: () => columns }).updateRegistrationData!(1, {}, trx)
      )
    for (const column of [
      'id',
      'email',
      'unverified_email',
      'password',
      'email_verified_at',
      'credentials_changed_at',
      'role',
      'ROLE',
      'Email',
      'full_name; drop table users',
    ]) {
      await assert.rejects(() => create({ [column]: 'x' }), /cannot assign/)
      await assert.rejects(() => update({ [column]: 'x' }), /cannot assign/)
    }
    for (const value of [null, [], 'full_name'])
      await assert.rejects(() => create(value as never), /must return an object of columns/)
    assert.lengthOf(await kit.db.from('app_users'), 0)
  })

  test('registration data needs a mapper and the mapper sees the operation', async ({ assert }) => {
    const contexts: unknown[] = []
    const mapped = adapter({
      mapRegistrationData: (data, context) => {
        contexts.push(context)
        return fullName(data)
      },
    })
    const user = await transaction(kit.db, (trx) =>
      mapped.create(
        {
          email: ' Ada@Example.Test ',
          password: 'password',
          unverifiedEmail: ' Ada@Example.Test ',
          registrationData: { fullName: 'Ada' },
        },
        trx
      )
    )
    assert.equal(user.email, 'ada@example.test')
    assert.equal(user.unverifiedEmail, 'ada@example.test')
    await transaction(kit.db, (trx) =>
      mapped.updateRegistrationData!(user.id, { fullName: 'Ada L' }, trx)
    )
    assert.deepEqual(contexts, [{ operation: 'create' }, { operation: 'update', id: user.id }])
    assert.equal(await fullNameOf('app_users', user.id), 'Ada L')

    const plain = adapter({ mapRegistrationData: undefined })
    await assert.rejects(
      () =>
        transaction(kit.db, (trx) =>
          plain.create(
            {
              email: 'b@example.test',
              password: null,
              unverifiedEmail: null,
              registrationData: {},
            },
            trx
          )
        ),
      /registrationData requires mapRegistrationData/
    )
    await assert.rejects(
      () => transaction(kit.db, (trx) => plain.updateRegistrationData!(user.id, {}, trx)),
      /registrationData requires mapRegistrationData/
    )
  })

  test('defaults to the application database and hash services', async ({ assert }) => {
    const defaults = createSqlUsersAdapter({ table: 'app_users' })
    const user = await transaction(kit.db, (trx) =>
      defaults.create(
        { email: 'c@example.test', password: 'password123', unverifiedEmail: null },
        trx
      )
    )
    const row = await kit.db.from('app_users').where('id', user.id).first()
    assert.notEqual(row.password, 'password123')
    assert.isTrue(await kit.hash.verify(row.password, 'password123'))
    const found = await defaults.findByEmail('C@example.test')
    assert.equal(found?.id, user.id)
    await transaction(kit.db, async (trx) => {
      assert.isTrue(await defaults.verifyPassword(user.id, 'password123', trx))
      assert.isFalse(await defaults.verifyPassword(user.id, 'wrong', trx))
    })
  })

  test('reads timestamps as UTC whatever the driver returns', async ({ assert }) => {
    const at = DateTime.fromISO('2026-03-04T05:06:07.000Z')
    const user = await transaction(kit.db, async (trx) => {
      const created = await adapter().create(
        {
          email: 'd@example.test',
          password: null,
          unverifiedEmail: null,
          registrationData: { fullName: 'D' },
        },
        trx
      )
      await adapter().markEmailVerified(created.id, at.setZone('America/New_York'), trx)
      return created
    })
    const read = await adapter().findById(user.id)
    assert.equal(read?.emailVerifiedAt?.toISO(), '2026-03-04T05:06:07.000Z')
    assert.equal(read?.emailVerifiedAt?.zoneName, 'UTC')
  })

  test('refuses a table name that is not a plain identifier', ({ assert }) => {
    for (const table of ['users; drop table users', 'public.users', ''])
      assert.throws(() => createSqlUsersAdapter({ table }), /plain SQL identifier/)
  })
})
