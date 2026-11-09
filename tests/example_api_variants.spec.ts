import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import { format, resolveConfig } from 'prettier'
import { migrationNames, migrationSchema, type UserIdType } from '../configure.js'
import { exampleRoot, renderApiVariant } from '../bin/helpers/consumer/api_variants.js'
import { bootTestApp, type TestApp } from './helpers/app.js'

const stubsRoot = fileURLToPath(new URL('../stubs', import.meta.url))
const exampleMigrations = join(exampleRoot, 'database/migrations')

/** The package migrations the example commits, by filename suffix, and the stub each one came from. */
const packageMigrations = new Map<string, string>([
  ...migrationNames.map((name) => [`_account_kit_${name}.ts`, name] as const),
  ['_account_kit_admission_create_account_admissions.ts', 'create_account_admissions'] as const,
])

/** Render a migration stub the way configure and the admission install do. */
async function renderPackageMigration(
  kit: TestApp,
  name: string,
  destination: string,
  usersTable: string,
  userIdType: UserIdType
) {
  const stubs = await kit.app.stubs.create()
  const stub = await stubs.build(`migrations/${name}.stub`, { source: stubsRoot })
  const prepared = await stub.prepare({
    migration: { ...migrationSchema(usersTable, userIdType), destination },
  })
  return prepared.contents
}

/** The stub output as the example commits it: the engine trims, the example's formatter formats. */
async function formatted(contents: string, filepath: string) {
  const options = await resolveConfig(filepath)
  return format(contents + '\n', { ...options, filepath })
}

// The committed example is the default rendering, so a change to either side fails here instead
// of drifting quietly until a consumer run.
test('the committed API example is the default rendering of its app-owned files', async ({
  assert,
}) => {
  const rendered = await renderApiVariant('users', 'integer')
  assert.sameMembers(
    [...rendered.keys()],
    [
      'app/models/user.ts',
      'app/controllers/admissions_controller.ts',
      'database/migrations/1761885935168_create_users_table.ts',
      'database/migrations/1768620764696_create_access_tokens_table.ts',
      'database/migrations/1791906000000_create_role_assignments.ts',
      'database/migrations/1800000000001_create_notifications_outbox.ts',
      'database/migrations/1800000000003_make_user_full_name_nullable.ts',
    ]
  )
  for (const [path, contents] of rendered) {
    assert.equal(await readFile(join(exampleRoot, path), 'utf8'), contents, path)
  }
})

test('the committed API example package migrations are the default configure output', async ({
  assert,
}) => {
  const kit = await bootTestApp()
  try {
    const committed = (await readdir(exampleMigrations)).filter((name) =>
      name.includes('_account_kit_')
    )
    assert.sameMembers(
      committed.map((name) => name.replace(/^\d+/, '')),
      [...packageMigrations.keys()],
      'the example commits exactly one migration per package stub'
    )
    for (const filename of committed) {
      const filepath = join(exampleMigrations, filename)
      const stub = packageMigrations.get(filename.replace(/^\d+/, ''))!
      const rendered = await renderPackageMigration(kit, stub, filepath, 'users', 'integer')
      assert.equal(await readFile(filepath, 'utf8'), await formatted(rendered, filepath), filename)
    }
  } finally {
    await kit.close()
  }
})

test('non-default variants change the users table, the ID columns and the model', async ({
  assert,
}) => {
  // Prettier wraps long call chains, so compare with whitespace removed.
  const flat = (rendered: Map<string, string>, path: string) =>
    rendered.get(path)!.replace(/\s+/g, '')
  const strings = await renderApiVariant('account_users', 'string')
  const users = flat(strings, 'database/migrations/1761885935168_create_users_table.ts')
  assert.include(users, "tableName='account_users'")
  assert.include(users, "table.string('id').primary().notNullable()")
  assert.include(
    flat(strings, 'database/migrations/1768620764696_create_access_tokens_table.ts'),
    "table.string('tokenable_id').notNullable().references('id').inTable('account_users')"
  )
  assert.include(
    flat(strings, 'database/migrations/1791906000000_create_role_assignments.ts'),
    ".references('account_users.id')"
  )
  assert.include(
    flat(strings, 'database/migrations/1800000000003_make_user_full_name_nullable.ts'),
    "usersTable='account_users'"
  )
  const model = flat(strings, 'app/models/user.ts')
  assert.include(model, "statictable='account_users'")
  assert.include(model, 'staticselfAssignPrimaryKey=true')
  assert.include(model, 'Object.assign(user,{id:randomUUID()})')
  const controller = flat(strings, 'app/controllers/admissions_controller.ts')
  assert.include(controller, 'functionuserIdParam(value:string):string')
  assert.include(controller, 'value.length>64')
  assert.notInclude(controller, 'Number.isSafeInteger')

  const uuids = await renderApiVariant('users', 'uuid')
  assert.include(
    flat(uuids, 'database/migrations/1761885935168_create_users_table.ts'),
    "table.uuid('id').primary().notNullable()"
  )
  assert.include(
    flat(uuids, 'database/migrations/1768620764696_create_access_tokens_table.ts'),
    "table.uuid('tokenable_id').notNullable().references('id').inTable('users')"
  )
  assert.include(
    flat(uuids, 'database/migrations/1800000000001_create_notifications_outbox.ts'),
    "table.uuid('user_id').notNullable().references('id').inTable('users')"
  )
  const uuidModel = flat(uuids, 'app/models/user.ts')
  assert.notInclude(uuidModel, 'statictable=')
  assert.include(uuidModel, 'staticselfAssignPrimaryKey=true')
  const uuidController = flat(uuids, 'app/controllers/admissions_controller.ts')
  assert.include(uuidController, 'functionuserIdParam(value:string):string')
  assert.include(uuidController, '[0-9a-f]{12}$/i.test(value)')

  await assert.rejects(() => renderApiVariant('Account Users', 'integer'), /Invalid users table/)
})

// The consumer migrates a rendered cell and runs the example's HTTP suites, which never delete a
// user. This keeps the schema-level guarantees for a rendered cell: the foreign keys reject
// orphans and cascade or null out on delete, as the committed default cell's spec checks.
test('a rendered variant schema keeps the foreign keys of the default cell', async ({ assert }) => {
  const usersTable = 'account_users'
  const postgresSchema =
    process.env.DB_CLIENT === 'pg'
      ? `account_schema_fixture_${randomUUID().replaceAll('-', '')}`
      : undefined
  const kit = await bootTestApp({ postgresSchema })
  try {
    const migrations = join(kit.migrationDirectory, 'variant-migrations')
    await mkdir(migrations)
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      join(kit.migrationDirectory, 'node_modules')
    )
    // The migrations are imported from this directory, so they must load as ES modules.
    await writeFile(
      join(kit.migrationDirectory, 'package.json'),
      JSON.stringify({ type: 'module' })
    )
    kit.db.config.connections.test.migrations!.paths = [migrations]

    const rendered = await renderApiVariant(usersTable, 'string')
    for (const filename of await readdir(exampleMigrations)) {
      const destination = join(migrations, filename)
      const appOwned = rendered.get(`database/migrations/${filename}` as never)
      const stub = packageMigrations.get(filename.replace(/^\d+/, ''))
      const contents = appOwned
        ? appOwned
        : stub
          ? await renderPackageMigration(kit, stub, destination, usersTable, 'string')
          : await readFile(join(exampleMigrations, filename), 'utf8')
      await writeFile(destination, contents)
    }
    const runner = new MigrationRunner(kit.db, kit.app, { direction: 'up' })
    await runner.run()
    if (runner.error) throw runner.error

    const now = new Date()
    const later = new Date(Date.now() + 60_000)
    const userId = `member-${randomUUID()}`
    const actorId = `actor-${randomUUID()}`
    for (const id of [userId, actorId]) {
      await kit.db.table(usersTable).insert({
        id,
        full_name: null,
        email: `${id}@example.test`,
        password: null,
        created_at: now,
        updated_at: now,
      })
    }
    const dependents: [string, Record<string, unknown>][] = [
      ['auth_access_tokens', { tokenable_id: userId, type: 'api', hash: 'a', abilities: '[]' }],
      ['role_assignments', { user_id: userId, role: 'member' }],
      [
        'account_kit_outbox',
        {
          user_id: userId,
          operation: 'test',
          operation_id: 'o',
          recipient_email: 'o@example.test',
        },
      ],
      [
        'password_reset_tokens',
        {
          tokenable_id: userId,
          email: 'r@example.test',
          hash: 'r',
          expires_at: later,
          created_at: now,
        },
      ],
      [
        'account_admissions',
        { user_id: userId, approval_actor_id: actorId, created_at: now, updated_at: now },
      ],
      [
        'account_invitations',
        {
          email: 'i@example.test',
          role: 'member',
          inviter_id: actorId,
          token_hash: 'i',
          expires_at: later,
          created_at: now,
          updated_at: now,
        },
      ],
    ]
    for (const [table, row] of dependents) await kit.db.table(table).insert(row)

    let orphanAccepted = false
    try {
      await kit.db.table('role_assignments').insert({ user_id: 'missing-user', role: 'member' })
      orphanAccepted = true
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'SQLITE_CONSTRAINT_FOREIGNKEY' && code !== '23503') throw error
    }
    assert.isFalse(orphanAccepted, 'a role assignment for an unknown user was accepted')

    await kit.db.from(usersTable).where('id', actorId).delete()
    assert.isNull(
      (await kit.db.from('account_invitations').where('token_hash', 'i').first())?.inviter_id
    )
    assert.isNull(
      (await kit.db.from('account_admissions').where('user_id', userId).first())?.approval_actor_id
    )
    await kit.db.from(usersTable).where('id', userId).delete()
    for (const [table, row] of dependents) {
      const column = 'tokenable_id' in row ? 'tokenable_id' : 'user_id'
      if (table === 'account_invitations') continue
      assert.lengthOf(await kit.db.from(table).where(column, userId), 0, `${table} cascades`)
    }
  } finally {
    try {
      const schema = kit.db.connection().schema
      for (const table of [
        'sessions',
        'account_kit_outbox',
        'rate_limits',
        'account_admissions',
        'account_sessions',
        'login_link_tokens',
        'social_handoff_codes',
        'social_sensitive_proofs',
        'social_transactions',
        'social_identities',
        'account_transaction_lock',
        'account_invitations',
        'email_verification_tokens',
        'password_reset_tokens',
        'role_assignments',
        'auth_access_tokens',
        usersTable,
      ]) {
        await schema.dropTableIfExists(table)
      }
      await schema.dropTableIfExists('adonis_schema_versions')
      await schema.dropTableIfExists('adonis_schema')
    } finally {
      await kit.close()
    }
  }
})
  .timeout(30_000)
  .skip(process.env.DB_CLIENT === 'mysql2', 'The API example runs on SQLite and PostgreSQL')
