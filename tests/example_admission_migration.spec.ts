import { randomUUID } from 'node:crypto'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import type { TestApp } from './helpers/app.js'
import { bootTestApp } from './helpers/app.js'
import { renderAdmissionMigration } from './helpers/admission_schema.js'

const exampleMigration = new URL(
  '../examples/api/database/migrations/1791906378315_account_kit_admission_create_account_admissions.ts',
  import.meta.url
)

const envSource = `
import { readFileSync } from 'node:fs'
export default {
  get(key: string) {
    const settings = JSON.parse(readFileSync(new URL('../schema-settings.json', import.meta.url), 'utf8'))
    return settings[key]
  },
}
`

async function migrate(kit: TestApp, migrationsPath: string, direction: 'up' | 'down') {
  kit.db.config.connections.test.migrations!.paths = [migrationsPath]
  const runner = new MigrationRunner(kit.db, kit.app, {
    direction,
    ...(direction === 'down' ? { step: 1 } : {}),
  })
  await runner.run()
  if (runner.error) throw runner.error
}

async function admissionSnapshot(kit: TestApp) {
  const columns = await kit.db.connection().getReadClient().table('account_admissions').columnInfo()
  const rawIndexes =
    process.env.DB_CLIENT === 'pg'
      ? await kit.db
          .rawQuery(
            'select indexname from pg_indexes where schemaname = current_schema() and tablename = ?',
            ['account_admissions']
          )
          .exec()
      : await kit.db.rawQuery("PRAGMA index_list('account_admissions')").exec()
  const indexes = Array.isArray(rawIndexes)
    ? rawIndexes
    : (rawIndexes as { rows: Array<{ indexname: string }> }).rows
  return {
    columns,
    indexes: indexes
      .map((index: { indexname?: string; name?: string }) => index.indexname ?? index.name)
      .sort(),
  }
}

async function proveAdmissionConstraints(kit: TestApp, prefix: string) {
  const now = new Date()
  const insertUser = async (email: string) => {
    await kit.db.table('users').insert({
      full_name: email,
      email,
      password: 'unused',
      created_at: now,
      updated_at: now,
    })
    const user = await kit.db.from('users').where('email', email).select('id').first()
    if (!user) throw new Error(`failed to create user ${email}`)
    return user.id
  }

  const ownerId = await insertUser(`${prefix}-owner@example.test`)
  const actorId = await insertUser(`${prefix}-actor@example.test`)
  const admission = {
    user_id: ownerId,
    approval_actor_id: actorId,
    invitation_id: 987654,
    created_at: now,
    updated_at: now,
  }
  await kit.db.table('account_admissions').insert(admission)
  const bootstrapAdmission = {
    user_id: null,
    bootstrap_email: `${prefix}-bootstrap@example.test`,
    invitation_id: 987654,
    created_at: now,
    updated_at: now,
  }
  await kit.db.table('account_admissions').insert(bootstrapAdmission)
  await assertRejectsDuplicate(kit, bootstrapAdmission)
  await kit.db.table('account_admissions').insert({ ...bootstrapAdmission, bootstrap_email: null })
  await kit.db.table('account_admissions').insert({ ...bootstrapAdmission, bootstrap_email: null })
  await assertRejectsOrphan(kit, { ...admission, user_id: -1 })
  await assertRejectsDuplicate(kit, admission)

  await kit.db.from('users').where('id', actorId).delete()
  const approved = await kit.db
    .from('account_admissions')
    .where('user_id', ownerId)
    .select('approval_actor_id')
    .first()
  if (approved?.approval_actor_id !== null) {
    throw new Error('deleting the approval actor did not set approval_actor_id to null')
  }

  await kit.db.from('users').where('id', ownerId).delete()
  const remaining = await kit.db.from('account_admissions').where('user_id', ownerId).first()
  if (remaining) throw new Error('deleting the admitted user did not cascade to its admission')
}

async function assertRejectsOrphan(kit: TestApp, admission: Record<string, unknown>) {
  try {
    await kit.db.table('account_admissions').insert(admission)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || code === '23503') return
    throw error
  }
  throw new Error('an admission referencing an unknown user was accepted')
}

async function assertRejectsDuplicate(kit: TestApp, admission: Record<string, unknown>) {
  try {
    await kit.db.table('account_admissions').insert(admission)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === '23505') return
    throw error
  }
  throw new Error('two admissions for one user were accepted')
}

test.group('example admission migration', () => {
  test('matches the rendered default schema and constraints', async ({ assert }) => {
    const postgresSchema =
      process.env.DB_CLIENT === 'pg'
        ? `account_schema_fixture_${randomUUID().replaceAll('-', '')}`
        : undefined
    const kit = await bootTestApp({ postgresSchema })
    try {
      const fixtureRoot = kit.migrationDirectory
      const sourceMigrations = join(fixtureRoot, 'source-migrations')
      const stubMigrations = join(fixtureRoot, 'stub-migrations')
      await Promise.all([mkdir(sourceMigrations), mkdir(stubMigrations)])
      await symlink(
        fileURLToPath(new URL('../node_modules', import.meta.url)),
        join(fixtureRoot, 'node_modules')
      )
      await writeFile(
        join(fixtureRoot, 'package.json'),
        JSON.stringify({ type: 'module', imports: { '#start/env': './start/env.js' } })
      )
      await writeFile(
        join(fixtureRoot, 'schema-settings.json'),
        JSON.stringify({
          ACCOUNT_KIT_USERS_TABLE: 'users',
          ACCOUNT_KIT_USER_ID_TYPE: 'integer',
        })
      )
      await mkdir(join(fixtureRoot, 'start'))
      await writeFile(join(fixtureRoot, 'start/env.ts'), envSource)

      await kit.db.connection().schema.dropTableIfExists('account_admissions')
      await kit.db.connection().schema.dropTableIfExists('users')
      await writeFile(
        join(sourceMigrations, '1791906378315_account_kit_admission_create_account_admissions.ts'),
        await readFile(exampleMigration)
      )
      const stubPath = join(
        stubMigrations,
        '1791906378315_account_kit_admission_create_account_admissions.ts'
      )
      await writeFile(stubPath, await renderAdmissionMigration(kit, stubPath))

      await kit.db.connection().schema.createTable('users', (table) => {
        table.increments('id').notNullable()
        table.string('full_name').notNullable()
        table.string('email', 254).notNullable().unique()
        table.string('password').notNullable()
        table.timestamp('created_at').notNullable()
        table.timestamp('updated_at').nullable()
      })

      await migrate(kit, sourceMigrations, 'up')
      const committedSchema = await admissionSnapshot(kit)
      await proveAdmissionConstraints(kit, 'committed')
      await migrate(kit, sourceMigrations, 'down')

      await migrate(kit, stubMigrations, 'up')
      const renderedSchema = await admissionSnapshot(kit)
      await proveAdmissionConstraints(kit, 'rendered')
      assert.deepEqual(committedSchema, renderedSchema)
    } finally {
      await kit.db.connection().schema.dropTableIfExists('account_admissions')
      await kit.db.connection().schema.dropTableIfExists('users')
      await kit.db.connection().schema.dropTableIfExists('adonis_schema_versions')
      await kit.db.connection().schema.dropTableIfExists('adonis_schema')
      await kit.close()
    }
  }).skip(
    process.env.DB_CLIENT === 'mysql2',
    'The API example supports SQLite and PostgreSQL; package MySQL migrations are covered separately'
  )
})
