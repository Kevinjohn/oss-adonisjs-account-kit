import { symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'
import { migrationNames, migrationSchema, type UserIdType } from '../configure.js'
import { createLucidAdapter } from '../adapters/lucid.js'
import { transaction } from '../src/db.js'
import { bootTestApp } from './helpers/app.js'
import { locksRows, testEngine } from './helpers/dialect.js'

const idTypes: UserIdType[] = ['integer', 'string', 'uuid']
const reservedUsersTable: Record<UserIdType, string> = {
  integer: 'order',
  string: 'group',
  uuid: 'user',
}

async function tableExists(kit: Awaited<ReturnType<typeof bootTestApp>>, table: string) {
  if (locksRows) {
    return !!(await kit.db
      .from('information_schema.tables')
      .select('table_name')
      .where('table_schema', testEngine === 'pg' ? 'public' : kit.db.raw('database()'))
      .where('table_name', table)
      .first())
  }
  return !!(await kit.db
    .from('sqlite_master')
    .select('name')
    .where('type', 'table')
    .where('name', table)
    .first())
}

for (const userIdType of idTypes) {
  test(`generates and rolls back migrations for ${userIdType} IDs and reserved custom table`, async ({
    assert,
  }) => {
    const usersTable = reservedUsersTable[userIdType]
    const kit = await bootTestApp()
    try {
      const schema = kit.db.connection().schema
      for (const table of [
        'email_verification_tokens',
        'login_link_tokens',
        'account_sessions',
        'social_handoff_codes',
        'social_sensitive_proofs',
        'social_transactions',
        'social_identities',
        'account_invitations',
        'password_reset_tokens',
        'account_transaction_lock',
        'adonis_schema_versions',
        'adonis_schema',
      ])
        await schema.dropTableIfExists(table)
      await schema.dropTableIfExists(usersTable)
      await schema.createTable(usersTable, (table) => {
        if (userIdType === 'integer') table.increments('id')
        else if (userIdType === 'uuid') table.uuid('id').primary()
        else table.string('id', 254).primary()
        table.string('email', 254).notNullable().unique()
        table.string('password').notNullable()
      })

      await symlink(
        fileURLToPath(new URL('../node_modules', import.meta.url)),
        join(kit.migrationDirectory, 'node_modules')
      )
      const stubsRoot = fileURLToPath(new URL('../stubs', import.meta.url))
      const stubs = await kit.app.stubs.create()
      const timestamp = Date.now()
      for (const [index, name] of migrationNames.entries()) {
        const stub = await stubs.build(`migrations/${name}.stub`, { source: stubsRoot })
        const prepared = await stub.prepare({
          migration: {
            ...migrationSchema(usersTable, userIdType),
            destination: join(
              kit.migrationDirectory,
              `${timestamp + index}_account_kit_${name}.ts`
            ),
          },
        })
        await writeFile(prepared.destination, prepared.contents)
      }

      const up = new MigrationRunner(kit.db, kit.app, { direction: 'up' })
      await up.run()
      if (up.error) throw up.error

      assert.isTrue(await tableExists(kit, 'password_reset_tokens'))
      assert.isTrue(await tableExists(kit, 'account_invitations'))
      assert.isTrue(await tableExists(kit, 'email_verification_tokens'))
      assert.isTrue(await tableExists(kit, 'social_identities'))
      assert.isFalse(await tableExists(kit, 'account_email_changes'))

      class SchemaUser extends BaseModel {
        static table = usersTable
        static selfAssignPrimaryKey = userIdType !== 'integer'

        @column({ isPrimary: true })
        declare id: number | string

        @column()
        declare email: string

        @column({ columnName: 'unverified_email' })
        declare unverifiedEmail: string | null

        @column()
        declare password: string | null

        @column.dateTime({ columnName: 'email_verified_at' })
        declare emailVerifiedAt: DateTime | null

        @beforeCreate()
        static assignId(user: SchemaUser) {
          if (userIdType !== 'integer')
            user.id = userIdType === 'uuid' ? randomUUID() : `member-${randomUUID()}`
        }
      }
      const adapter = createLucidAdapter(async () => SchemaUser)
      const created = await transaction(kit.db, (trx) =>
        adapter.create(
          {
            email: ' Pending@Example.Test ',
            unverifiedEmail: ' Pending@Example.Test ',
            password: null,
          },
          trx
        )
      )
      assert.equal(created.email, 'pending@example.test')
      assert.equal(created.unverifiedEmail, 'pending@example.test')
      assert.isFalse(created.hasPassword)
      assert.isNull(created.emailVerifiedAt)
      assert.equal(typeof created.id, userIdType === 'integer' ? 'number' : 'string')
      if (userIdType === 'uuid') assert.match(String(created.id), /^[0-9a-f-]{36}$/)
      const persisted = await kit.db.from(usersTable).where('id', created.id).first()
      assert.isNull(persisted.password)
      assert.equal(persisted.unverified_email, created.email)
      const reloaded = await adapter.findById(created.id)
      assert.equal(reloaded?.unverifiedEmail, created.email)

      const identity = {
        user_id: created.id,
        provider: 'example',
        provider_user_id: `subject-${userIdType}`,
        email_verified: false,
        created_at: new Date(),
        updated_at: new Date(),
      }
      await kit.db.table('social_identities').insert(identity)
      const orphanId = userIdType === 'integer' ? 999999 : randomUUID()
      await assert.rejects(() =>
        kit.db
          .table('social_identities')
          .insert({ ...identity, user_id: orphanId, provider_user_id: `orphan-${userIdType}` })
      )
      await kit.db.from(usersTable).where('id', created.id).delete()
      assert.lengthOf(await kit.db.from('social_identities').where('user_id', created.id), 0)

      const down = new MigrationRunner(kit.db, kit.app, {
        direction: 'down',
        step: migrationNames.length,
      })
      await down.run()
      if (down.error) throw down.error

      for (const table of [
        'account_transaction_lock',
        'account_email_changes',
        'email_verification_tokens',
        'login_link_tokens',
        'account_sessions',
        'social_handoff_codes',
        'social_sensitive_proofs',
        'social_transactions',
        'social_identities',
        'account_invitations',
        'password_reset_tokens',
      ]) {
        assert.isFalse(await tableExists(kit, table))
      }
      assert.isTrue(await tableExists(kit, usersTable))
    } finally {
      for (const table of [
        'email_verification_tokens',
        'login_link_tokens',
        'account_sessions',
        'social_handoff_codes',
        'social_sensitive_proofs',
        'social_transactions',
        'social_identities',
        'account_invitations',
        'password_reset_tokens',
        'account_transaction_lock',
        usersTable,
      ]) {
        await kit.db.connection().schema.dropTableIfExists(table)
      }
      await kit.close()
    }
  }).timeout(30_000)
}

test('migration schema quotes reserved table names and selects each supported ID column type', async ({
  assert,
}) => {
  for (const userIdType of idTypes) {
    const usersTable = reservedUsersTable[userIdType]
    const schema = migrationSchema(usersTable, userIdType)
    assert.equal(schema.usersTable, JSON.stringify(usersTable))
    if (userIdType === 'integer') {
      assert.equal(schema.userIdColumn, "table.integer('user_id').unsigned()")
      assert.equal(schema.inviterIdColumn, "table.integer('inviter_id').unsigned()")
    } else if (userIdType === 'uuid') {
      assert.equal(schema.userIdColumn, "table.uuid('user_id')")
      assert.equal(schema.inviterIdColumn, "table.uuid('inviter_id')")
    } else {
      assert.equal(schema.userIdColumn, "table.string('user_id', 254)")
      assert.equal(schema.inviterIdColumn, "table.string('inviter_id', 254)")
    }
  }
})

test('migration schema rejects invalid table identifiers and unsupported ID types', async ({
  assert,
}) => {
  for (const invalidTable of ['', '1users', 'app.users', 'users;drop table users']) {
    assert.throws(() => migrationSchema(invalidTable))
  }
  assert.throws(() => migrationSchema('users', 'bigint' as UserIdType))
})
