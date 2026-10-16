import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import { migrationSchema } from '../configure.js'
import { bootTestApp } from './helpers/app.js'
import { makeService } from './helpers/fakes.js'
import { generateToken, hashToken } from '../src/tokens.js'

const legacy = [
  'create_password_reset_tokens',
  'create_account_invitations',
  'create_account_email_changes',
  'add_email_verified_at_to_users',
  'create_account_transaction_lock',
]
const evolution = ['evolve_identity_contract', 'retire_account_email_changes']

test('upgrade preserves outstanding reset and email-change proofs and backfills state', async ({
  assert,
}) => {
  const kit = await bootTestApp()
  try {
    const schema = kit.db.connection().schema
    for (const table of [
      'application_roles',
      'social_identities',
      'email_verification_tokens',
      'account_email_changes',
      'account_invitations',
      'password_reset_tokens',
      'account_transaction_lock',
      'adonis_schema_versions',
      'adonis_schema',
      'users',
    ]) {
      await schema.dropTableIfExists(table)
    }
    await schema.createTable('users', (table) => {
      table.increments('id')
      table.string('email').notNullable().unique()
      table.string('password').notNullable()
      table.timestamp('created_at').notNullable()
    })
    await kit.db.connection().schema.createTable('application_roles', (table) => {
      table.increments('id')
      table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('role').notNullable()
    })
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      join(kit.migrationDirectory, 'node_modules')
    )
    const stubs = await kit.app.stubs.create()
    const stubsRoot = fileURLToPath(new URL('../stubs', import.meta.url))
    await mkdir(kit.migrationDirectory, { recursive: true })
    const writeMigrations = async (names: string[], offset: number) => {
      for (const [index, name] of names.entries()) {
        const destination = join(
          kit.migrationDirectory,
          `${1900000000000 + offset + index}_account_kit_${name}.ts`
        )
        const stub = await stubs.build(`migrations/${name}.stub`, { source: stubsRoot })
        const prepared = await stub.prepare({
          migration: {
            ...migrationSchema('users', 'integer'),
            destination,
          },
        })
        await writeFile(destination, prepared.contents)
      }
      const runner = new MigrationRunner(kit.db, kit.app, { direction: 'up' })
      await runner.run()
      if (runner.error) throw runner.error
    }
    await writeMigrations(legacy, 0)
    const now = new Date().toISOString()
    const [inactiveId] = await kit.db
      .table('users')
      .insert({ email: 'inactive@example.test', password: 'hash', created_at: now })
      .returning('id')
    const [activeId] = await kit.db
      .table('users')
      .insert({
        email: 'active@example.test',
        password: 'hash',
        email_verified_at: now,
        created_at: now,
      })
      .returning('id')
    const [changingId] = await kit.db
      .table('users')
      .insert({
        email: 'changing@example.test',
        password: 'hash',
        email_verified_at: now,
        created_at: now,
      })
      .returning('id')
    const [inactiveChangingId] = await kit.db
      .table('users')
      .insert({ email: 'inactive-changing@example.test', password: 'hash', created_at: now })
      .returning('id')
    const id = (value: unknown) =>
      typeof value === 'object' && value !== null ? (value as { id: number }).id : (value as number)
    const resetToken = generateToken(32)
    const emailToken = generateToken(32)
    const inactiveEmailToken = generateToken(32)
    const future = new Date(Date.now() + 3600_000).toISOString()
    await kit.db.table('password_reset_tokens').insert({
      user_id: id(inactiveId),
      email: 'inactive@example.test',
      token_hash: hashToken(resetToken),
      expires_at: future,
      created_at: now,
    })
    await kit.db.table('application_roles').insert({ user_id: id(changingId), role: 'owner' })
    await kit.db.table('account_email_changes').insert({
      user_id: id(changingId),
      current_email: 'changing@example.test',
      new_email: 'next@example.test',
      token_hash: hashToken(emailToken),
      expires_at: future,
      created_at: now,
    })
    await kit.db.table('account_email_changes').insert({
      user_id: id(inactiveChangingId),
      current_email: 'inactive-changing@example.test',
      new_email: 'inactive-next@example.test',
      token_hash: hashToken(inactiveEmailToken),
      expires_at: future,
      created_at: now,
    })
    const [expiredChangeId] = await kit.db
      .table('users')
      .insert({ email: 'expired-change@example.test', password: 'hash', created_at: now })
      .returning('id')
    await kit.db.table('account_email_changes').insert({
      user_id: id(expiredChangeId),
      current_email: 'expired-change@example.test',
      new_email: 'expired-next@example.test',
      token_hash: hashToken(generateToken(32)),
      expires_at: new Date(Date.now() - 3600_000).toISOString(),
      created_at: now,
    })
    const [staleId] = await kit.db
      .table('users')
      .insert({ email: 'stale@example.test', password: 'hash', created_at: now })
      .returning('id')
    await kit.db.table('account_email_changes').insert({
      user_id: id(staleId),
      current_email: 'prior@example.test',
      new_email: 'stale-next@example.test',
      token_hash: hashToken(generateToken(32)),
      expires_at: future,
      created_at: now,
    })
    assert.lengthOf(await kit.db.from('account_email_changes'), 4)
    await assert.rejects(() => writeMigrations(evolution, 100), /proof no longer matches its user/)
    assert.lengthOf(await kit.db.from('account_email_changes'), 4)
    await kit.db.from('account_email_changes').where('user_id', id(staleId)).delete()
    await writeMigrations(evolution, 100)
    const inactive = await kit.db.from('users').where('id', id(inactiveId)).first()
    const active = await kit.db.from('users').where('id', id(activeId)).first()
    const changing = await kit.db.from('users').where('id', id(changingId)).first()
    const inactiveChanging = await kit.db.from('users').where('id', id(inactiveChangingId)).first()
    assert.equal(inactive.unverified_email, inactive.email)
    assert.isNull(active.unverified_email)
    assert.equal(changing.email, 'changing@example.test')
    assert.equal(changing.unverified_email, 'next@example.test')
    assert.equal(inactiveChanging.email, 'inactive-next@example.test')
    assert.equal(inactiveChanging.unverified_email, 'inactive-next@example.test')
    assert.isNull(inactiveChanging.email_verified_at)
    const expiredChange = await kit.db.from('users').where('id', id(expiredChangeId)).first()
    assert.equal(expiredChange.email, 'expired-change@example.test')
    assert.equal(expiredChange.unverified_email, 'expired-change@example.test')
    assert.lengthOf(
      await kit.db.from('email_verification_tokens').where('tokenable_id', id(expiredChangeId)),
      0
    )
    const reset = await kit.db.from('password_reset_tokens').first()
    assert.equal(reset.tokenable_id, id(inactiveId))
    assert.equal(reset.hash, hashToken(resetToken))
    const change = await kit.db
      .from('email_verification_tokens')
      .where('tokenable_id', id(changingId))
      .first()
    assert.equal(change.tokenable_id, id(changingId))
    assert.equal(change.hash, hashToken(emailToken))
    assert.equal(change.purpose, 'email_change')
    const inactiveChange = await kit.db
      .from('email_verification_tokens')
      .where('tokenable_id', id(inactiveChangingId))
      .first()
    assert.equal(inactiveChange.hash, hashToken(inactiveEmailToken))
    assert.equal(inactiveChange.current_email, 'inactive-next@example.test')
    assert.equal(inactiveChange.purpose, 'email_change')
    assert.lengthOf(await kit.db.from('application_roles').where('user_id', id(changingId)), 1)
    await kit.db.from('users').where('id', id(activeId)).update({ password: null })
    const passwordless = await kit.db.from('users').where('id', id(activeId)).first()
    assert.isNull(passwordless.password)
    assert.isFalse(await kit.db.connection().schema.hasTable('account_email_changes'))
    const { account } = makeService(kit)
    assert.isTrue(await account.passwordReset.inspect({ token: resetToken }))
    const resetUser = await account.passwordReset.reset({
      token: resetToken,
      password: 'newPassword123',
    })
    assert.equal(resetUser.email, 'inactive@example.test')
    const changedUser = await account.emailPasswordManagement.completeEmailChange({
      token: emailToken,
    })
    assert.equal(changedUser.email, 'next@example.test')
    const inactiveChangedUser = await account.emailPasswordManagement.completeEmailChange({
      token: inactiveEmailToken,
    })
    assert.equal(inactiveChangedUser.email, 'inactive-next@example.test')
    assert.isNull(inactiveChangedUser.unverifiedEmail)
  } finally {
    await kit.db.connection().schema.dropTableIfExists('application_roles')
    await kit.close()
  }
}).timeout(30_000)

test('API example evolution rejects stale proofs and skips expired ones without deleting source rows', async ({
  assert,
}) => {
  const kit = await bootTestApp()
  try {
    const schema = kit.db.connection().schema
    for (const table of [
      'social_identities',
      'email_verification_tokens',
      'account_email_changes',
      'account_invitations',
      'password_reset_tokens',
      'account_transaction_lock',
      'adonis_schema_versions',
      'adonis_schema',
      'users',
    ])
      await schema.dropTableIfExists(table)
    await schema.createTable('users', (table) => {
      table.increments('id')
      table.string('email').notNullable().unique()
      table.string('password').notNullable()
      table.timestamp('email_verified_at').nullable()
    })
    await schema.createTable('password_reset_tokens', (table) => {
      table.increments('id')
      table.integer('user_id')
      table.string('token_hash')
    })
    await schema.createTable('account_email_changes', (table) => {
      table.increments('id')
      table.integer('user_id')
      table.string('current_email')
      table.string('new_email')
      table.string('token_hash')
      table.timestamp('expires_at')
      table.timestamp('created_at')
    })
    const [inserted] = await kit.db
      .table('users')
      .insert({ email: 'current@example.test', password: 'hash' })
      .returning('id')
    const userId = typeof inserted === 'object' ? inserted.id : inserted
    const proof = {
      user_id: userId,
      current_email: 'prior@example.test',
      new_email: 'next@example.test',
      token_hash: hashToken(generateToken(32)),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      created_at: new Date().toISOString(),
    }
    await kit.db.table('account_email_changes').insert(proof)
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      join(kit.migrationDirectory, 'node_modules')
    )
    const example = await readFile(
      fileURLToPath(
        new URL(
          '../examples/api/database/migrations/1791906378309_account_kit_evolve_identity_contract.ts',
          import.meta.url
        )
      ),
      'utf8'
    )
    await writeFile(
      join(kit.migrationDirectory, '1900000000200_account_kit_evolve_identity_contract.ts'),
      example.replace(
        "import env from '#start/env'",
        'const env = { get: (_name: string) => undefined }'
      )
    )
    const runner = new MigrationRunner(kit.db, kit.app, { direction: 'up' })
    await runner.run()
    assert.match(String(runner.error), /proof no longer matches its user/)
    assert.lengthOf(await kit.db.from('account_email_changes'), 1)
    const preserved = await kit.db.from('users').where('id', userId).first()
    assert.equal(preserved.email, 'current@example.test')
    await kit.db.from('account_email_changes').delete()
    await kit.db.table('account_email_changes').insert({
      ...proof,
      current_email: 'current@example.test',
      expires_at: new Date(Date.now() - 3600_000).toISOString(),
    })
    const retry = new MigrationRunner(kit.db, kit.app, { direction: 'up' })
    await retry.run()
    if (retry.error) throw retry.error
    const unchanged = await kit.db.from('users').where('id', userId).first()
    assert.equal(unchanged.email, 'current@example.test')
    assert.equal(unchanged.unverified_email, 'current@example.test')
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
  } finally {
    await kit.close()
  }
}).timeout(30_000)
