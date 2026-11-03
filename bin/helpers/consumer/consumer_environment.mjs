import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { database, secret } from './settings.mjs'

/** A loopback port the OS reports free, so concurrent runs on one machine do not collide. */
async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return String(port)
}

const port = await freePort()

export function databaseEnvironment(appRoot, schema = 'account_kit_consumer') {
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
