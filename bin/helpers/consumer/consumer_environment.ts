import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { database, secret } from './settings.js'

/** Probes a free loopback port to reduce collisions; closing the probe does not reserve it. */
async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected loopback port')
  const { port } = address
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return String(port)
}

const port = await freePort()

export function databaseEnvironment(_appRoot: string, schema = 'account_kit_consumer') {
  const dbEnv = {
    ...process.env,
    NODE_ENV: 'test',
    TZ: 'UTC',
    LOG_LEVEL: 'silent',
    PORT: port,
    HOST: '127.0.0.1',
    APP_KEY: `account-kit-consumer-${randomBytes(24).toString('hex')}`,
    APP_URL: `http://127.0.0.1:${port}`,
    SESSION_DRIVER: 'memory',
    LIMITER_STORE: 'memory',
    DB_CONNECTION: database === 'sqlite' ? 'sqlite' : 'postgres',
  }
  if (database === 'postgres') {
    Object.assign(dbEnv, {
      DB_HOST: process.env.DB_HOST ?? '127.0.0.1',
      DB_PORT: process.env.DB_PORT ?? '55432',
      DB_USER: process.env.DB_USER ?? 'account_kit',
      DB_PASSWORD: secret,
      DB_DATABASE: process.env.DB_DATABASE ?? schema,
    })
  }
  return dbEnv
}
