import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'

/** Start each journey from an empty migrated database. */
export async function setupAccountDatabase() {
  const cleanup = await testUtils.db().truncate()
  await cleanup()
  await db.table('account_transaction_lock').insert({ id: 1, version: 0 }).onConflict('id').ignore()
  return cleanup
}
