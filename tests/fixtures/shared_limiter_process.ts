import { fileURLToPath } from 'node:url'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import { LimiterManager } from '@adonisjs/limiter'
import LimiterDatabaseStore from '@adonisjs/limiter/stores/database'
import { ThrottledError } from '../../src/errors.js'
import { consume } from '../../src/throttle.js'

const filename = process.env.ACCOUNT_KIT_TEST_DB!
const secret = process.env.ACCOUNT_KIT_TEST_SECRET!
const namespace = process.env.ACCOUNT_KIT_TEST_NAMESPACE!
const root = fileURLToPath(new URL('../..', import.meta.url))
const ignitor = new IgnitorFactory()
  .withCoreProviders()
  .withCoreConfig()
  .merge({
    rcFileContents: { providers: [() => import('@adonisjs/lucid/database_provider')] },
    config: {
      database: defineDatabaseConfig({
        connection: 'test',
        connections: {
          test: {
            client: 'better-sqlite3',
            connection: { filename },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 },
          },
        },
      }),
    },
  })
  .create(new URL(`file://${root}/`))
const app = ignitor.createApp('console')

try {
  await app.init()
  await app.boot()
  const db = await app.container.make('lucid.db')
  const limiter = new LimiterManager({
    default: 'database',
    stores: {
      database: (options) =>
        new LimiterDatabaseStore(db.connection(), {
          ...options,
          tableName: 'rate_limits',
        }),
    },
  })
  const results: Array<{ throttled: boolean; status?: number }> = []
  for (const [operation, key] of [
    ['recovery:email', 'person@example.test'],
    ['recovery:client', '192.0.2.14'],
  ]) {
    try {
      await consume(
        limiter as never,
        operation,
        key,
        { requests: 1, duration: '1h' },
        secret,
        namespace
      )
      results.push({ throttled: false })
    } catch (error) {
      if (!(error instanceof ThrottledError)) throw error
      results.push({ throttled: true, status: error.status })
    }
  }
  process.stdout.write(`${JSON.stringify(results)}\n`)
} finally {
  await ignitor.terminate()
}
