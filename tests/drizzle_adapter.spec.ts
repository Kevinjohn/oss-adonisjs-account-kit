import { test } from '@japa/runner'
import * as pg from 'drizzle-orm/pg-core'
import * as sqlite from 'drizzle-orm/sqlite-core'
import { createDrizzleAdapter } from '../adapters/drizzle.js'
import { assertUsersAdapterContract } from '../testing/adapter_contract.js'
import { useTestApp } from './helpers/app.js'
import { createAppUsersTable } from './helpers/app_users_table.js'
import { contractFixture, fakeHash } from './helpers/adapter_contract_fixture.js'

const pgUsers = pg.pgTable('app_users', {
  id: pg.serial('id').primaryKey(),
  email: pg.varchar('email', { length: 254 }).notNull().unique(),
  unverifiedEmail: pg.varchar('unverified_email', { length: 254 }),
  password: pg.varchar('password', { length: 255 }),
  emailVerifiedAt: pg.timestamp('email_verified_at', { withTimezone: true }),
  fullName: pg.varchar('full_name', { length: 255 }),
})

const sqliteUsers = sqlite.sqliteTable('app_users', {
  id: sqlite.integer('id').primaryKey({ autoIncrement: true }),
  email: sqlite.text('email').notNull().unique(),
  unverifiedEmail: sqlite.text('unverified_email'),
  password: sqlite.text('password'),
  emailVerifiedAt: sqlite.text('email_verified_at'),
  fullName: sqlite.text('full_name'),
})

const options = {
  ...fakeHash,
  mapRegistrationData: (data: unknown) => ({ full_name: (data as { fullName: string }).fullName }),
}

test.group('Drizzle users adapter', (group) => {
  const kit = useTestApp(group)
  group.each.setup(() => createAppUsersTable(kit, 'app_users'))

  for (const [dialect, table] of [
    ['PostgreSQL', pgUsers],
    ['SQLite', sqliteUsers],
  ] as const)
    test(`passes the adapter contract with a ${dialect} table definition`, async ({ assert }) => {
      const adapter = createDrizzleAdapter(table, { ...options, db: kit.db })
      assert.deepEqual(await adapter.resolveMetadata(), { table: 'app_users', primaryKey: 'id' })
      await assertUsersAdapterContract(
        contractFixture(kit, adapter, {
          table: 'app_users',
          registrationData: { fullName: 'Drizzle User' },
        })
      )
    })

  test('validates the table definition on first use, naming the problem', async ({ assert }) => {
    const cases: Array<[object, RegExp]> = [
      [{}, /expects a Drizzle table/],
      [
        pg.pgTable('app_users', {
          id: pg.serial('id').primaryKey(),
          email: pg.text('email_address'),
          unverifiedEmail: pg.text('unverified_email'),
          password: pg.text('password'),
          emailVerifiedAt: pg.timestamp('email_verified_at'),
        }),
        /map the email property to the email column/,
      ],
      [
        pg.pgTable('app_users', {
          id: pg.serial('id').primaryKey(),
          email: pg.text('email'),
          password: pg.text('password'),
          emailVerifiedAt: pg.timestamp('email_verified_at'),
        }),
        /map the unverifiedEmail property to the unverified_email column/,
      ],
      [
        pg.pgSchema('accounts').table('app_users', {
          id: pg.serial('id').primaryKey(),
          email: pg.text('email'),
          unverifiedEmail: pg.text('unverified_email'),
          password: pg.text('password'),
          emailVerifiedAt: pg.timestamp('email_verified_at'),
        }),
        /must be in the default schema/,
      ],
      [
        sqlite.sqliteTable('app_users', {
          id: sqlite.integer('id').primaryKey(),
          email: sqlite.text('email'),
          unverifiedEmail: sqlite.text('unverified_email'),
          password: sqlite.text('password'),
          emailVerifiedAt: sqlite.integer('email_verified_at', { mode: 'timestamp' }),
        }),
        /store email_verified_at as text on SQLite/,
      ],
      [
        pg.pgTable('app users', {
          id: pg.serial('id').primaryKey(),
          email: pg.text('email'),
          unverifiedEmail: pg.text('unverified_email'),
          password: pg.text('password'),
          emailVerifiedAt: pg.timestamp('email_verified_at'),
        }),
        /plain SQL identifier/,
      ],
    ]
    for (const [table, message] of cases) {
      // Building the adapter never throws; a config file can import it safely.
      const adapter = createDrizzleAdapter(table, { db: kit.db })
      await assert.rejects(() => adapter.resolveMetadata(), message)
      await assert.rejects(() => adapter.findById(1), message)
    }
  })
})
