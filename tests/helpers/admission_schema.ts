import type { Group } from '@japa/runner/core'
import type { BootOptions, TestApp } from './app.js'
import { bootTestApp } from './app.js'
import { clearRows, resetSchema } from './schema.js'
import { createAdmissionTable, dropAdmissionTable } from './admission_migration.js'

export {
  admissionMigrationSuffix,
  createAdmissionTable,
  dropAdmissionTable,
  renderAdmissionMigration,
} from './admission_migration.js'

/**
 * Like `useTestApp`, with the admission table created per group and emptied before each test.
 * `createTable` replaces the stub-built table, for a group that needs a different schema.
 */
export function useAdmissionApp(
  group: Group,
  options: BootOptions = {},
  createTable: (kit: TestApp) => Promise<void> = createAdmissionTable
): TestApp {
  const kit = {} as TestApp
  group.setup(async () => {
    Object.assign(kit, await bootTestApp(options))
    await dropAdmissionTable(kit)
    await resetSchema(kit)
    await createTable(kit)
  })
  group.each.setup(async () => {
    await kit.db.from('account_admissions').delete()
    await clearRows(kit)
    await kit.limiter.clear()
  })
  group.teardown(async () => {
    await dropAdmissionTable(kit)
    await kit.close()
  })
  return kit
}
