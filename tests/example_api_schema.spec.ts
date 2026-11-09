import { randomUUID } from 'node:crypto'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import type { BaseModel } from '@adonisjs/lucid/orm'
import { bootTestApp, type TestApp } from './helpers/app.js'

const migrationSource = new URL('../examples/api/database/migrations/', import.meta.url)
const usersTable = 'users'
const idType = 'integer'

const optionalNameMigration = '1800000000003_make_user_full_name_nullable.ts'
const baseSchemaMigrations = [
  '1761885935168_create_users_table.ts',
  '1768620764696_create_access_tokens_table.ts',
  '1791906000000_create_role_assignments.ts',
  '1791906378304_account_kit_add_account_columns_to_users.ts',
  '1791906378305_account_kit_create_password_reset_tokens.ts',
  '1791906378306_account_kit_create_email_verification_tokens.ts',
  '1791906378307_account_kit_create_account_invitations.ts',
  '1791906378308_account_kit_create_account_transaction_lock.ts',
  '1791906378309_account_kit_create_social_identities.ts',
  '1791906378310_account_kit_create_social_transactions.ts',
  '1791906378311_account_kit_create_social_sensitive_proofs.ts',
  '1791906378312_account_kit_create_social_handoff_codes.ts',
  '1791906378313_account_kit_create_login_link_tokens.ts',
  '1791906378314_account_kit_create_account_sessions.ts',
  '1791906378315_account_kit_admission_create_account_admissions.ts',
  '1791906378316_account_kit_add_scope_to_account_invitations.ts',
  '1791906405253_create_rate_limits_table.ts',
  '1800000000001_create_notifications_outbox.ts',
  '1800000000002_create_sessions_table.ts',
]

/** Copy the committed example migrations into the test app, as a consumer would run them. */
async function prepareMigrations(kit: TestApp) {
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(kit.migrationDirectory, 'node_modules')
  )
  const fixtureMigrations = join(kit.migrationDirectory, 'fixture-migrations')
  await mkdir(fixtureMigrations)
  kit.db.config.connections.test.migrations!.paths = [fixtureMigrations]
  // The generated schema is imported from this directory, so it must load as an ES module.
  await writeFile(join(kit.migrationDirectory, 'package.json'), JSON.stringify({ type: 'module' }))
  await Promise.all(
    baseSchemaMigrations.map(async (filename) => {
      const source = await readFile(new URL(filename, migrationSource))
      await writeFile(join(fixtureMigrations, filename), source)
    })
  )

  return async (direction: 'up' | 'down', step?: number) => {
    const runner = new MigrationRunner(kit.db, kit.app, {
      direction,
      ...(step === undefined ? {} : { step }),
    })
    await runner.run()
    return runner
  }
}

test('optional-name migration keeps the users table and the full_name type and default', async ({
  assert,
}) => {
  const client = process.env.DB_CLIENT
  const postgresSchema =
    client === 'pg' ? `account_schema_fixture_${randomUUID().replaceAll('-', '')}` : undefined
  const kit = await bootTestApp({ postgresSchema })
  try {
    const migrate = await prepareMigrations(kit)
    const initial = await migrate('up')
    if (initial.error) throw initial.error

    const longName = 'n'.repeat(300)
    if (client === 'pg') {
      await kit.db.rawQuery(
        "ALTER TABLE users ALTER COLUMN full_name TYPE text, ALTER COLUMN full_name SET DEFAULT 'Member'"
      )
      const now = new Date()
      await kit.db.table('users').insert({
        full_name: longName,
        email: 'long-name@example.test',
        password: 'unused',
        created_at: now,
        updated_at: now,
      })
    }
    const rootPage = () =>
      kit.db
        .from('sqlite_master')
        .where({ type: 'table', name: 'users' })
        .select('rootpage')
        .first()
        .then((row) => row?.rootpage)
    const rootPageBefore = client === 'pg' ? undefined : await rootPage()

    await writeFile(
      join(kit.migrationDirectory, 'fixture-migrations', optionalNameMigration),
      await readFile(new URL(optionalNameMigration, migrationSource))
    )
    const upgrade = await migrate('up')
    if (upgrade.error) throw upgrade.error

    const userColumns = await kit.db.connection().getReadClient().table('users').columnInfo()
    const fullName = userColumns.full_name
    assert.isTrue(fullName.nullable)
    if (client === 'pg') {
      assert.equal(fullName.type, 'text')
      assert.include(String(fullName.defaultValue), 'Member')
      assert.equal(
        await kit.db
          .from('users')
          .where('email', 'long-name@example.test')
          .select('full_name')
          .first()
          .then((row) => row?.full_name),
        longName
      )
    } else {
      assert.equal(await rootPage(), rootPageBefore, 'the users table must not be rebuilt')
    }
  } finally {
    await kit.close()
  }
}).skip(process.env.DB_CLIENT === 'mysql2', 'The API example runs on SQLite and PostgreSQL')

// The other users table and ID type cells run through `pnpm test:consumer`, which renders them
// over a copy of the example.
test('committed API migrations support the default users table with integer IDs', async ({
  assert,
}) => {
  const postgresSchema =
    process.env.DB_CLIENT === 'pg'
      ? `account_schema_fixture_${randomUUID().replaceAll('-', '')}`
      : undefined
  const kit = await bootTestApp({ postgresSchema })
  try {
    const migrate = await prepareMigrations(kit)
    const initial = await migrate('up')
    if (initial.error) throw initial.error

    const now = new Date()
    const later = new Date(Date.now() + 60_000)
    await kit.db.table(usersTable).insert({
      full_name: 'Existing Named User',
      email: `legacy-${idType}@example.test`,
      password: 'unused',
      created_at: now,
      updated_at: now,
    })
    const legacyUser = await kit.db
      .from(usersTable)
      .where('email', `legacy-${idType}@example.test`)
      .select('id', 'full_name')
      .first()
    if (!legacyUser) throw new Error('failed to create the pre-upgrade user')
    await kit.db.table('password_reset_tokens').insert({
      tokenable_id: legacyUser.id,
      email: `legacy-${idType}@example.test`,
      hash: `legacy-reset-${idType}`,
      expires_at: later,
      created_at: now,
    })
    await writeFile(
      join(kit.migrationDirectory, 'fixture-migrations', optionalNameMigration),
      await readFile(new URL(optionalNameMigration, migrationSource))
    )
    const upgrade = await migrate('up')
    if (upgrade.error) throw upgrade.error
    assert.equal(
      await kit.db
        .from(usersTable)
        .where('id', legacyUser.id)
        .select('full_name')
        .first()
        .then((row) => row?.full_name),
      'Existing Named User',
      'up migration must preserve existing user names'
    )
    assert.isOk(
      await kit.db.from('password_reset_tokens').where('hash', `legacy-reset-${idType}`).first(),
      'up migration must preserve dependent token rows'
    )
    const userColumns = await kit.db.connection().getReadClient().table(usersTable).columnInfo()
    assert.isTrue(userColumns.full_name.nullable)

    const schemaGeneratorModule = await import(
      new URL('./schema_generator/generator.js', import.meta.resolve('@adonisjs/lucid/orm')).href
    )
    const generatedSchemaPath = join(kit.migrationDirectory, 'generated_schema.ts')
    const schemaGenerator = new schemaGeneratorModule.OrmSchemaGenerator(kit.db, kit.app, {
      connectionName: 'test',
      ...(postgresSchema ? { schemas: [postgresSchema] } : {}),
      outputPath: generatedSchemaPath,
    })
    await schemaGenerator.generate()
    const generatedSchema = await readFile(generatedSchemaPath, 'utf8')
    const userSchemaClass = 'UserSchema'
    const userSchemaStart = generatedSchema.indexOf(
      `export class ${userSchemaClass} extends BaseModel`
    )
    assert.isAtLeast(userSchemaStart, 0)
    const nextSchemaStart = generatedSchema.indexOf('\nexport class ', userSchemaStart + 1)
    const userSchemaSource = generatedSchema.slice(
      userSchemaStart,
      nextSchemaStart === -1 ? undefined : nextSchemaStart
    )
    assert.include(userSchemaSource, 'declare id: number')
    assert.include(userSchemaSource, 'declare fullName: string | null')
    const generatedSchemaModule = await import(
      new URL('generated_schema.ts', `file://${kit.migrationDirectory}/`).href
    )
    const GeneratedUserSchema = generatedSchemaModule[userSchemaClass] as typeof BaseModel
    class SchemaUser extends GeneratedUserSchema {
      static table = usersTable

      declare id: number
      declare email: string
      declare fullName: string | null
      declare password: string | null
    }

    const namelessUser = await SchemaUser.create({
      fullName: null,
      email: `nameless-${idType}@example.test`,
      password: null,
    })
    const blockedDown = await migrate('down', 1)
    assert.equal(
      (blockedDown.error as Error | undefined)?.message,
      'Cannot restore required user names while users have NULL full_name; assign names explicitly before rolling back.'
    )
    const stillNullable = await kit.db.connection().getReadClient().table(usersTable).columnInfo()
    assert.isTrue(stillNullable.full_name.nullable)
    assert.isOk(
      await kit.db
        .from('adonis_schema')
        .where('name', 'like', '%1800000000003_make_user_full_name_nullable%')
        .first(),
      'blocked down migration must remain recorded as applied'
    )
    assert.equal(
      await kit.db
        .from(usersTable)
        .where('id', legacyUser.id)
        .select('full_name')
        .first()
        .then((row) => row?.full_name),
      'Existing Named User'
    )
    assert.isOk(
      await kit.db.from('password_reset_tokens').where('hash', `legacy-reset-${idType}`).first(),
      'blocked down migration must preserve dependent token rows'
    )
    assert.isOk(
      await kit.db.from(usersTable).where('id', namelessUser.id).whereNull('full_name').first(),
      'blocked down migration must preserve the row causing refusal'
    )
    await kit.db.from(usersTable).where('id', namelessUser.id).delete()
    const rollbackOptionalName = await migrate('down', 1)
    if (rollbackOptionalName.error) throw rollbackOptionalName.error
    assert.isNull(
      await kit.db
        .from('adonis_schema')
        .where('name', 'like', '%1800000000003_make_user_full_name_nullable%')
        .first(),
      'successful down migration must be recorded as rolled back'
    )
    const requiredNameColumns = await kit.db
      .connection()
      .getReadClient()
      .table(usersTable)
      .columnInfo()
    assert.isFalse(requiredNameColumns.full_name.nullable)
    assert.equal(
      await kit.db
        .from(usersTable)
        .where('id', legacyUser.id)
        .select('full_name')
        .first()
        .then((row) => row?.full_name),
      'Existing Named User',
      'successful down migration must preserve existing user rows'
    )
    assert.isOk(
      await kit.db.from('password_reset_tokens').where('hash', `legacy-reset-${idType}`).first(),
      'successful down migration must preserve dependent token rows'
    )

    const user = await SchemaUser.create({
      fullName: 'Primary User',
      email: `primary-${idType}@example.test`,
      password: null,
    })
    const actor = await SchemaUser.create({
      fullName: 'Approval Actor',
      email: `actor-${idType}@example.test`,
      password: null,
    })
    const userId = user.id
    const actorId = actor.id
    assert.isNull(
      await kit.db
        .from(usersTable)
        .where('id', userId)
        .select('password')
        .first()
        .then((row) => row?.password)
    )

    await kit.db.table('password_reset_tokens').insert({
      tokenable_id: userId,
      email: user.email,
      hash: `reset-${idType}`,
      expires_at: later,
      created_at: now,
    })
    await kit.db.table('email_verification_tokens').insert({
      tokenable_id: userId,
      email: user.email,
      hash: `verify-${idType}`,
      expires_at: later,
      created_at: now,
    })
    await kit.db.table('login_link_tokens').insert({
      tokenable_id: userId,
      email: user.email,
      hash: `login-${idType}`,
      client_challenge: 'challenge',
      expires_at: later,
      created_at: now,
    })
    await kit.db.table('account_invitations').insert({
      email: `invite-${idType}@example.test`,
      role: 'member',
      inviter_id: actorId,
      token_hash: `invite-token-${idType}`,
      expires_at: later,
      created_at: now,
      updated_at: now,
    })
    await kit.db.table('social_identities').insert({
      user_id: userId,
      provider: 'example',
      provider_user_id: `subject-${idType}`,
      email_verified: false,
      created_at: now,
      updated_at: now,
    })
    const identity = await kit.db
      .from('social_identities')
      .where('provider_user_id', `subject-${idType}`)
      .select('id')
      .first()
    if (!identity) throw new Error('social identity was not inserted')
    await kit.db.table('social_transactions').insert({
      hash: `social-transaction-${idType}`,
      provider: 'example',
      intent: 'login',
      client_challenge: 'challenge',
      user_id: userId,
      expires_at: later,
      created_at: now,
    })
    await kit.db.table('social_sensitive_proofs').insert({
      hash: `proof-${idType}`,
      user_id: userId,
      purpose: 'password-change',
      expires_at: later,
      created_at: now,
    })
    await kit.db.table('social_handoff_codes').insert({
      hash: `handoff-${idType}`,
      user_id: userId,
      social_identity_id: identity.id,
      client_challenge: 'challenge',
      expires_at: later,
      created_at: now,
    })
    await kit.db.table('account_sessions').insert({
      user_id: userId,
      handle_hash: `session-${idType}`,
      created_at: now,
      last_seen_at: now,
      expires_at: later,
    })
    await kit.db.table('account_admissions').insert({
      user_id: userId,
      approval_actor_id: actorId,
      created_at: now,
      updated_at: now,
    })
    await kit.db.table('auth_access_tokens').insert({
      tokenable_id: userId,
      type: 'api',
      hash: `access-${idType}`,
      abilities: '[]',
      created_at: now,
    })
    await kit.db.table('role_assignments').insert({ user_id: userId, role: 'member' })
    await kit.db.table('account_kit_outbox').insert({
      user_id: userId,
      operation: 'test',
      operation_id: `outbox-${idType}`,
      recipient_email: user.email,
    })

    const orphanId = 999_999
    try {
      await kit.db.table('social_identities').insert({
        user_id: orphanId,
        provider: 'orphan',
        provider_user_id: `orphan-subject-${idType}`,
        email_verified: false,
        created_at: now,
        updated_at: now,
      })
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'SQLITE_CONSTRAINT_FOREIGNKEY' && code !== '23503') throw error
    }
    if (await kit.db.from('social_identities').where('provider', 'orphan').first()) {
      throw new Error('an orphan social identity was accepted')
    }

    await kit.db.from(usersTable).where('id', actorId).delete()
    assert.isNull(
      await kit.db
        .from('account_invitations')
        .where('token_hash', `invite-token-${idType}`)
        .select('inviter_id')
        .first()
        .then((row) => row?.inviter_id)
    )
    assert.isNull(
      await kit.db
        .from('account_admissions')
        .where('user_id', userId)
        .select('approval_actor_id')
        .first()
        .then((row) => row?.approval_actor_id)
    )

    await kit.db.from(usersTable).where('id', userId).delete()
    for (const [table, fieldName] of [
      ['password_reset_tokens', 'tokenable_id'],
      ['email_verification_tokens', 'tokenable_id'],
      ['login_link_tokens', 'tokenable_id'],
      ['social_identities', 'user_id'],
      ['social_transactions', 'user_id'],
      ['social_sensitive_proofs', 'user_id'],
      ['social_handoff_codes', 'user_id'],
      ['account_sessions', 'user_id'],
      ['account_admissions', 'user_id'],
      ['auth_access_tokens', 'tokenable_id'],
      ['role_assignments', 'user_id'],
      ['account_kit_outbox', 'user_id'],
    ]) {
      assert.lengthOf(await kit.db.from(table).where(fieldName, userId), 0, `${table}.${fieldName}`)
    }

    const rollbackDependents = await migrate('down', baseSchemaMigrations.length - 4)
    if (rollbackDependents.error) throw rollbackDependents.error
    assert.isTrue(await kit.db.connection().schema.hasTable(usersTable))
    for (const columnName of ['email_verified_at', 'unverified_email', 'credentials_changed_at']) {
      assert.isTrue(await kit.db.connection().schema.hasColumn(usersTable, columnName))
    }
    const passwordBeforeAlterDown = await kit.db
      .connection()
      .getReadClient()
      .table(usersTable)
      .columnInfo()
    assert.isTrue(passwordBeforeAlterDown.password.nullable)

    const rollbackAccountColumns = new MigrationRunner(kit.db, kit.app, {
      direction: 'down',
      step: 1,
    })
    await rollbackAccountColumns.run()
    if (rollbackAccountColumns.error) throw rollbackAccountColumns.error
    for (const columnName of ['email_verified_at', 'unverified_email', 'credentials_changed_at']) {
      assert.isFalse(await kit.db.connection().schema.hasColumn(usersTable, columnName))
    }
    const passwordAfterAlterDown = await kit.db
      .connection()
      .getReadClient()
      .table(usersTable)
      .columnInfo()
    assert.isTrue(passwordAfterAlterDown.password.nullable)

    const rollbackBase = new MigrationRunner(kit.db, kit.app, {
      direction: 'down',
      step: 3,
    })
    await rollbackBase.run()
    if (rollbackBase.error) throw rollbackBase.error
    for (const table of [
      usersTable,
      'auth_access_tokens',
      'role_assignments',
      'password_reset_tokens',
      'email_verification_tokens',
      'account_invitations',
      'account_transaction_lock',
      'social_identities',
      'social_transactions',
      'social_sensitive_proofs',
      'social_handoff_codes',
      'login_link_tokens',
      'account_sessions',
      'account_admissions',
      'rate_limits',
      'account_kit_outbox',
      'sessions',
    ]) {
      assert.isFalse(await kit.db.connection().schema.hasTable(table), `${table} rollback`)
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
  .skip(
    process.env.DB_CLIENT === 'mysql2',
    'The API example supports SQLite and PostgreSQL; package MySQL migrations are covered separately'
  )
