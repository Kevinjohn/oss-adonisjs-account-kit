import { test } from '@japa/runner'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { migrationSchema } from '../configure.js'
import { useTestApp } from './helpers/app.js'

test.group('users migration', (group) => {
  const kit = useTestApp(group)

  async function loadMigration() {
    const destination = join(kit.migrationDirectory, `${Date.now()}_users_migration_probe.ts`)
    const stubs = await kit.app.stubs.create()
    const stub = await stubs.build('migrations/add_account_columns_to_users.stub', {
      source: fileURLToPath(new URL('../stubs', import.meta.url)),
    })
    const prepared = await stub.prepare({
      migration: { ...migrationSchema('users', 'integer'), destination },
    })
    await writeFile(destination, prepared.contents)
    const module = await import(pathToFileURL(destination).href)
    return module.default
  }

  test('SQLite older than 3.53 fails before any change with an upgrade hint', async ({
    assert,
  }) => {
    const Migration = await loadMigration()
    const touched: string[] = []
    const client = {
      dialect: { name: 'better-sqlite3' },
      rawQuery: async () => [{ version: '3.51.3' }],
      get schema() {
        touched.push('schema')
        return {}
      },
    }
    const migration = new Migration(client, 'probe.ts')
    await assert.rejects(() => migration.up(), /upgrade better-sqlite3 to 12\.10 or later/)
    assert.deepEqual(touched, [])
  })
})
