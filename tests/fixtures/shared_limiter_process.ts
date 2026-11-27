import { fileURLToPath } from 'node:url'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { defineConfig as defineDatabaseConfig } from '@adonisjs/lucid'
import { defineConfig as defineLimiterConfig, stores } from '@adonisjs/limiter'
import { E_ACCOUNT_KIT_THROTTLED } from '../../src/errors.ts'
import { consume } from '../../src/throttle.ts'

const filename = process.env.ACCOUNT_KIT_TEST_DB!
const secret = process.env.ACCOUNT_KIT_TEST_SECRET!
const namespace = process.env.ACCOUNT_KIT_TEST_NAMESPACE!
const root = fileURLToPath(new URL('../..', import.meta.url))
const ignitor = new IgnitorFactory()
  .withCoreProviders()
  .withCoreConfig()
  .merge({
    rcFileContents: {
      providers: [
        () => import('@adonisjs/lucid/database_provider'),
        () => import('@adonisjs/limiter/limiter_provider'),
      ],
    },
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
      limiter: defineLimiterConfig({
        default: 'database',
        stores: {
          database: stores.database({ tableName: 'rate_limits' }),
        },
      }),
    },
  })
  .create(new URL(`file://${root}/`))
const app = ignitor.createApp('console')

try {
  await app.init()
  await app.boot()
  const limiter = await app.container.make('limiter.manager')
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
      if (!(error instanceof E_ACCOUNT_KIT_THROTTLED)) throw error
      results.push({ throttled: true, status: error.status })
    }
  }
  process.stdout.write(`${JSON.stringify(results)}\n`)
} finally {
  await ignitor.terminate()
}
