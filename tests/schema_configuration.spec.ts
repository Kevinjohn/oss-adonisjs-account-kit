import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import type Configure from '@adonisjs/core/commands/configure'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import { configure, migrationNames, migrationSchema, type UserIdType } from '../configure.js'
import { bootTestApp } from './helpers/app.js'

const idTypes: UserIdType[] = ['integer', 'string', 'uuid']
const reservedUsersTable: Record<UserIdType, string> = {
  integer: 'order',
  string: 'group',
  uuid: 'user',
}

async function tableExists(kit: Awaited<ReturnType<typeof bootTestApp>>, table: string) {
  if (process.env.DB_CLIENT === 'pg') {
    return !!(await kit.db
      .from('information_schema.tables')
      .select('table_name')
      .where('table_schema', 'public')
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

test('generates and rolls back migrations for every user ID type and reserved custom table', async ({
  assert,
}) => {
  for (const userIdType of idTypes) {
    const usersTable = reservedUsersTable[userIdType]
    const kit = await bootTestApp()
    try {
      const schema = kit.db.connection().schema
      for (const table of [
        'account_email_changes',
        'email_verification_tokens',
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
        'social_identities',
        'account_invitations',
        'password_reset_tokens',
      ]) {
        assert.isFalse(await tableExists(kit, table))
      }
      assert.isTrue(await tableExists(kit, usersTable))
    } finally {
      for (const table of [
        'account_email_changes',
        'email_verification_tokens',
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
  }
}).timeout(30_000)

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

test('configure passes dashed and camel-case CLI schema flags into generated migrations', async ({
  assert,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'account-kit-schema-flags-'))
  try {
    await mkdir(join(root, 'database', 'migrations'), { recursive: true })
    await mkdir(join(root, 'start'), { recursive: true })
    await writeFile(join(root, 'start', 'env.ts'), '')

    for (const [parsedFlags, userIdType] of [
      [{ 'users-table': 'order', 'user-id-type': 'uuid' }, 'uuid'],
      [{ usersTable: 'group', userIdType: 'string' }, 'string'],
    ] as const) {
      const migrationData: Array<Record<string, unknown>> = []
      const codemods = {
        overwriteExisting: true,
        async makeUsingStub(_root: string, name: string, data: Record<string, unknown>) {
          if (name.startsWith('migrations/'))
            migrationData.push(data.migration as Record<string, unknown>)
        },
        async updateRcFile(
          update: (rcFile: {
            addProvider(name: string): void
            addCommand(name: string): void
          }) => void
        ) {
          update({ addProvider() {}, addCommand() {} })
        },
        async defineEnvValidations() {},
      }
      const command = {
        parsedFlags,
        stubsRoot: fileURLToPath(new URL('../stubs', import.meta.url)),
        app: { makePath: (...parts: string[]) => join(root, ...parts) },
        logger: { info() {}, warning() {} },
        async createCodemods() {
          return codemods
        },
      } as unknown as Configure

      await configure(command)
      assert.lengthOf(migrationData, migrationNames.length)
      for (const migration of migrationData) {
        assert.equal(
          migration.usersTable,
          JSON.stringify(parsedFlags['users-table'] ?? parsedFlags.usersTable)
        )
        if (userIdType === 'uuid') assert.equal(migration.userIdColumn, "table.uuid('user_id')")
        if (userIdType === 'string')
          assert.equal(migration.userIdColumn, "table.string('user_id', 254)")
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
