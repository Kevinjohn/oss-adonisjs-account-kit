/*
|--------------------------------------------------------------------------
| Define HTTP limiters
|--------------------------------------------------------------------------
|
| The "limiter.define" method creates an HTTP middleware to apply rate
| limits to routes. Configure trusted proxies in the deployment so
| request.ip() reflects the actual client address.
|
*/

import { createHmac } from 'node:crypto'
import env from '#start/env'
import limiter from '@adonisjs/limiter/services/main'

const normalizedIdentity = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

const requestKey = (value: string) =>
  createHmac('sha256', env.get('APP_KEY').release()).update(value).digest('hex')

export const clientRateLimitKey = (clientIp: string) => requestKey(clientIp)

export const identityRateLimitKey = (clientIp: string, identity: unknown) =>
  requestKey(`${clientIp}\0${normalizedIdentity(identity)}`)

export const loginClientThrottle = limiter.define('login-client', (ctx) => {
  return limiter
    .allowRequests(20)
    .every('15 minutes')
    .usingKey(clientRateLimitKey(ctx.request.ip()))
})

export const loginThrottle = limiter.define('login-identity', (ctx) => {
  return limiter
    .allowRequests(5)
    .every('15 minutes')
    .usingKey(identityRateLimitKey(ctx.request.ip(), ctx.request.input('email')))
})

export const throttle = limiter.define('global', () => {
  return limiter.allowRequests(10).every('1 minute')
})
