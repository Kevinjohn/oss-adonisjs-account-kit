/** The database engine under test, from `DB_CLIENT`. */
export const testEngine: 'sqlite' | 'pg' | 'mysql' =
  process.env.DB_CLIENT === 'pg' ? 'pg' : process.env.DB_CLIENT === 'mysql2' ? 'mysql' : 'sqlite'

/** SQLite serialises writers with one database lock; PostgreSQL and MySQL lock rows. */
export const locksRows = testEngine !== 'sqlite'

/** The error code a lock request that must not wait fails with. */
export const lockNotAvailableCode = { sqlite: 'SQLITE_BUSY', pg: '55P03', mysql: 'ER_LOCK_NOWAIT' }[
  testEngine
]
