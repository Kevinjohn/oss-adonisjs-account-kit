import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'

/**
 * Run pending migrations before a test and truncate every table after it.
 * Truncation also empties the singleton row the account_transaction_lock migration
 * seeds, so the cleanup puts it back for the next test.
 */
export async function truncateDatabase() {
  const truncate = await testUtils.db().truncate()
  return async () => {
    await truncate()
    await db.table('account_transaction_lock').insert({ id: 1, version: 0 })
  }
}
