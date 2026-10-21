import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import { migrationSchema, type UserIdType } from '../../configure.js'
import type { TestApp } from './app.js'

export const admissionMigrationSuffix = '_account_kit_admission_create_account_admissions.ts'

/** Render the admission migration stub the way install does. */
export async function renderAdmissionMigration(
  kit: TestApp,
  destination: string,
  options: { usersTable?: string; userIdType?: UserIdType } = {}
): Promise<string> {
  const stubs = await kit.app.stubs.create()
  const stub = await stubs.build('migrations/create_account_admissions.stub', {
    source: fileURLToPath(new URL('../../stubs', import.meta.url)),
  })
  const prepared = await stub.prepare({
    migration: {
      ...migrationSchema(options.usersTable ?? 'users', options.userIdType ?? 'integer'),
      destination,
    },
  })
  return prepared.contents
}

/** Create `account_admissions` from the stub, after `resetSchema`. Core specs never do this. */
export async function createAdmissionTable(
  kit: TestApp,
  options: { usersTable?: string; userIdType?: UserIdType } = {}
): Promise<void> {
  const destination = join(kit.migrationDirectory, `${Date.now()}${admissionMigrationSuffix}`)
  await writeFile(destination, await renderAdmissionMigration(kit, destination, options))
  const runner = new MigrationRunner(kit.db, kit.app, { direction: 'up' })
  await runner.run()
  if (runner.error) throw runner.error
}

/** Drop `account_admissions` so later groups can drop the users table it references. */
export async function dropAdmissionTable(kit: TestApp): Promise<void> {
  await kit.db.connection().schema.dropTableIfExists('account_admissions')
}
