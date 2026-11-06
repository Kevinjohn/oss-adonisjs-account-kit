import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import limiter from '@adonisjs/limiter/services/main'

/**
 * Run pending migrations before a test and truncate every table after it.
 * Truncation also empties the singleton row the account_transaction_lock migration
 * seeds, so the cleanup puts it back for the next test. Rate-limit buckets are cleared too, so
 * one test's requests from 127.0.0.1 do not spend the next test's budget.
 */
export async function truncateDatabase() {
  const truncate = await testUtils.db().truncate()
  return async () => {
    await truncate()
    await limiter.clear()
    await db.table('account_transaction_lock').insert({ id: 1, version: 0 })
  }
}
