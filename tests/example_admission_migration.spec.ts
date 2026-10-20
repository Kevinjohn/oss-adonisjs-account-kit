import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { bootTestApp } from './helpers/app.js'
import { renderAdmissionMigration } from './helpers/admission_schema.js'

const exampleMigration = new URL(
  '../examples/api/database/migrations/1791906378315_account_kit_admission_create_account_admissions.ts',
  import.meta.url
)

/** Whitespace and quote style differ between the stub and the formatted example; the code must not. */
const code = (source: string) => source.replaceAll(/\s+/g, '').replaceAll('"', "'")

test.group('example admission migration', () => {
  test('matches the migration stub rendered for the example schema', async ({ assert }) => {
    const kit = await bootTestApp()
    try {
      const rendered = await renderAdmissionMigration(
        kit,
        join(kit.migrationDirectory, 'unused.ts')
      )
      assert.equal(code(await readFile(exampleMigration, 'utf8')), code(rendered))
    } finally {
      await kit.close()
    }
  })
})
