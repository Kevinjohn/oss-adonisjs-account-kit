import { test } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import { isUserEmailUniqueViolation, lockUser, transaction, userMetadata } from '../src/db.js'
import type { UsersAdapterMetadata } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'
import { lockNotAvailableCode, locksRows } from './helpers/dialect.js'

test.group('custom user metadata', (group) => {
  const kit = useTestApp(group)

  test('uses valid adapter metadata and rejects unsafe metadata', async ({ assert }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const validConfig = defineConfig(
      makeConfig({
        users: {
          ...users,
          resolveMetadata: async () => ({
            table: 'metadata_accounts',
            primaryKey: 'id',
            emailConstraint: 'metadata_accounts_email_unique',
          }),
        },
      })
    )
    assert.deepEqual(await userMetadata(validConfig), {
      table: 'metadata_accounts',
      primaryKey: 'id',
      emailConstraint: 'metadata_accounts_email_unique',
    })

    for (const metadata of [
      { table: 'accounts; drop table users', primaryKey: 'id' },
      { table: 'accounts', primaryKey: 'account_id' },
    ]) {
      const invalidConfig = defineConfig(
        makeConfig({
          users: {
            ...users,
            resolveMetadata: async () => metadata as UsersAdapterMetadata,
          },
        })
      )
      await assert.rejects(() => userMetadata(invalidConfig), /adapter metadata/)
    }
  })

  test('classifies actual conventional and custom email uniqueness failures only', async ({
    assert,
  }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const conventionalConfig = defineConfig(makeConfig({ users }))
    await kit.db.table('users').insert({
      email: 'duplicate@example.test',
      created_at: new Date(),
    })

    let duplicateEmail: unknown
    try {
      await kit.db.table('users').insert({
        email: 'duplicate@example.test',
        created_at: new Date(),
      })
    } catch (error) {
      duplicateEmail = error
    }
    assert.isDefined(duplicateEmail)
    assert.isTrue(await isUserEmailUniqueViolation(duplicateEmail, conventionalConfig, kit.db))

    const schema = kit.db.connection().schema
    await schema.dropTableIfExists('metadata_accounts')
    await schema.createTable('metadata_accounts', (table) => {
      table.increments('id')
      table.string('email').notNullable()
      table.string('handle').notNullable()
      table.unique(['email'], 'custom_accounts_email_key')
      table.unique(['handle'], 'custom_accounts_handle_key')
    })
    try {
      await kit.db.table('metadata_accounts').insert({
        email: 'custom@example.test',
        handle: 'first',
      })
      const customUsers = {
        ...makeUsersAdapter(kit.db, kit.hash, 'metadata_accounts'),
        resolveMetadata: async () => ({
          table: 'metadata_accounts',
          primaryKey: 'id' as const,
          emailConstraint: 'custom_accounts_email_key',
        }),
      }
      const customConfig = defineConfig(makeConfig({ users: customUsers }))

      let customEmailViolation: unknown
      try {
        await kit.db.table('metadata_accounts').insert({
          email: 'custom@example.test',
          handle: 'second',
        })
      } catch (error) {
        customEmailViolation = error
      }
      assert.isDefined(customEmailViolation)
      assert.isTrue(await isUserEmailUniqueViolation(customEmailViolation, customConfig, kit.db))

      let unrelatedUniqueViolation: unknown
      try {
        await kit.db.table('metadata_accounts').insert({
          email: 'another@example.test',
          handle: 'first',
        })
      } catch (error) {
        unrelatedUniqueViolation = error
      }
      assert.isDefined(unrelatedUniqueViolation)
      assert.isFalse(
        await isUserEmailUniqueViolation(unrelatedUniqueViolation, customConfig, kit.db)
      )
    } finally {
      await kit.db.connection().schema.dropTableIfExists('metadata_accounts')
    }
  })

  test('locks the resolved PostgreSQL row even when the adapter ignores forUpdate', async ({
    assert,
  }) => {
    if (!locksRows) return

    const table = 'metadata_accounts'
    const schema = kit.db.connection().schema
    await schema.dropTableIfExists(table)
    await schema.createTable(table, (builder) => {
      builder.increments('id')
      builder.string('email').notNullable().unique()
      builder.timestamp('created_at').notNullable()
    })
    try {
      await kit.db.table(table).insert({
        email: 'locked@example.test',
        created_at: new Date(),
      })
      const row = await kit.db
        .from(table)
        .select('id')
        .where('email', 'locked@example.test')
        .first()
      const id = row.id as number
      const adapter = makeUsersAdapter(kit.db, kit.hash, table)
      const users = {
        ...adapter,
        async findById(userId: number | string, trx?: Parameters<typeof adapter.findById>[1]) {
          return adapter.findById(userId, trx, { forUpdate: false })
        },
        async findByEmail(email: string, trx?: Parameters<typeof adapter.findByEmail>[1]) {
          return adapter.findByEmail(email, trx, { forUpdate: false })
        },
      }
      const config = defineConfig(makeConfig({ users, usersTable: table }))

      let locked!: () => void
      let release!: () => void
      const ready = new Promise<void>((resolve) => (locked = resolve))
      const hold = new Promise<void>((resolve) => (release = resolve))
      const lockTransaction = transaction(kit.db, async (trx) => {
        await lockUser(trx, config, id)
        locked()
        await hold
      })
      await ready

      let lockFailure: unknown
      try {
        await kit.db.transaction(async (trx) => {
          await trx.rawQuery(`select id from ${table} where id = ? for update nowait`, [id]).exec()
        })
      } catch (error) {
        lockFailure = error
      } finally {
        release()
      }
      await lockTransaction
      assert.equal((lockFailure as { code?: string } | undefined)?.code, lockNotAvailableCode)
    } finally {
      await schema.dropTableIfExists(table)
    }
  }).timeout(8000)
})
