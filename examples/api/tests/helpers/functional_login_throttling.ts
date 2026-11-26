import env from '#start/env'
import { createHmac, hkdfSync } from 'node:crypto'

export function storedLoginKey(operation: string, value: string) {
  const secret = env.get('APP_KEY').release()
  const derived = Buffer.from(
    hkdfSync('sha256', secret, 'adonisjs-account-kit', 'limiter-key-v1', 32)
  )
  return `account-kit:v1:${createHmac('sha256', derived)
    .update(JSON.stringify(['default', operation, value]))
    .digest('hex')}`
}
