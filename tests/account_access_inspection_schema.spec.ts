import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import { bootTestApp } from './helpers/app.js'
import { failure } from './helpers/failure.js'
import { makeService, makeUsersAdapter } from './helpers/fakes.js'
import { dropPackageTables, resetSchema } from './helpers/schema.js'
import { dbTime } from './helpers/db_time.js'
import { testEngine } from './helpers/dialect.js'
import { AccountAccessDeniedError } from '../src/errors.js'

const authentication = { strategy: 'session' as const, guard: 'web' }

for (const scenario of [
  '15 string ids',
  '20 custom members table',
  '21 PostgreSQL UUID canonicalization',
]) {
  test(scenario, async ({ assert }) => {
    const kit = await bootTestApp()
    const members = scenario.startsWith('20')
    const uuidColumn = scenario.startsWith('21')
    const table = members ? 'members' : 'users'
    try {
      if (uuidColumn) {
        const schema = kit.db.connection().schema
        await dropPackageTables(schema)
        await schema.dropTableIfExists('users')
        await schema.createTable('users', (builder) => {
          builder.uuid('id').primary()
          builder.string('email').notNullable()
          builder.string('unverified_email').nullable()
          builder.string('password').nullable()
          builder.timestamp('email_verified_at').nullable()
          builder.timestamp('credentials_changed_at').nullable()
          builder.timestamp('created_at').notNullable()
        })
      } else {
        await resetSchema(kit, { stringUserIds: !members, usersTable: table })
      }
      const id = members ? 1 : randomUUID()
      await kit.db.table(table).insert({
        id,
        email: 'person@example.test',
        unverified_email: null,
        password: await kit.hash.make('password123'),
        email_verified_at: dbTime(kit),
        created_at: dbTime(kit),
      })
      let metadata = 0
      const base = makeUsersAdapter(kit.db, kit.hash, table)
      const users: typeof base = { ...base }
      const { account } = makeService(kit, {
        authentication,
        usersTable: table,
        users,
      })
      // Add the metadata observer after config validation: explicit table overrides and
      // metadata-bearing adapters cannot be supplied together at configuration time.
      users.resolveMetadata = async () => {
        metadata++
        return { table, primaryKey: 'id' }
      }
      const snapshot = await account.authentication.inspectAccountAccess({
        userId: uuidColumn ? String(id).toUpperCase() : id,
        requireActive: true,
      })
      assert.strictEqual(snapshot.account.id, id)
      assert.isAbove(metadata, 0)
      if (!members)
        assert.instanceOf(
          await failure(() =>
            account.authentication.inspectAccountAccess({
              userId: randomUUID(),
              requireActive: true,
            })
          ),
          AccountAccessDeniedError
        )
    } finally {
      await kit.close()
    }
  }).skip(uuidScenarioDisabled(scenario))
}

function uuidScenarioDisabled(scenario: string) {
  return scenario.startsWith('21') && testEngine !== 'pg'
}
