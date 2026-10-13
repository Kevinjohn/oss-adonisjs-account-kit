import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import type { TestApp } from './app.js'

const migrationNames = [
  'create_account_recovery_tokens',
  'create_account_invitations',
  'create_account_email_changes',
  'add_email_verified_at_to_users',
]

export async function resetSchema(
  kit: TestApp,
  options: { stringUserIds?: boolean } = {}
): Promise<void> {
  const schema = kit.db.connection().schema
  await schema.dropTableIfExists('account_email_changes')
  await schema.dropTableIfExists('account_invitations')
  await schema.dropTableIfExists('account_recovery_tokens')
  await schema.dropTableIfExists('adonis_schema_versions')
  await schema.dropTableIfExists('adonis_schema')
  await schema.dropTableIfExists('users')
  await schema.createTable('users', (table) => {
    if (options.stringUserIds) table.string('id', 36).primary()
    else table.increments('id')
    table.string('email').notNullable().unique()
    table.string('password').nullable()
    table.timestamp('created_at').notNullable()
  })

  await rm(kit.migrationDirectory, { recursive: true, force: true })
  await mkdir(kit.migrationDirectory, { recursive: true })
  await symlink(
    fileURLToPath(new URL('../../node_modules', import.meta.url)),
    join(kit.migrationDirectory, 'node_modules')
  )
  const stubsRoot = fileURLToPath(new URL('../../stubs', import.meta.url))
  const timestamp = Date.now()
  const stubs = await kit.app.stubs.create()

  for (const [index, name] of migrationNames.entries()) {
    const filename = `${timestamp + index}_account_kit_${name}.ts`
    const stub = await stubs.build(`migrations/${name}.stub`, { source: stubsRoot })
    const prepared = await stub.prepare({
      migration: { destination: join(kit.migrationDirectory, filename) },
    })
    // Applications with text/UUID IDs adapt their owned migration foreign keys.
    const contents = options.stringUserIds
      ? prepared.contents.replace(
          /table\.integer\('(user_id|inviter_id)'\)\.unsigned\(\)/g,
          "table.string('$1', 36)"
        )
      : prepared.contents
    await writeFile(prepared.destination, contents)
  }

  const runner = new MigrationRunner(kit.db, kit.app, { direction: 'up' })
  await runner.run()
  if (runner.error) throw runner.error
}
