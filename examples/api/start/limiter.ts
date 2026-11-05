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

import limiter from '@adonisjs/limiter/services/main'

/**
 * Client budget for public account writes that Account Kit does not throttle itself: signup and
 * the proof completions. Separate names keep each route's budget independent.
 */
export const accountPublicLimit = (name: string) =>
  limiter.define(`account-${name}`, (ctx) =>
    limiter.allowRequests(5).every('15 minutes').usingKey(ctx.request.ip())
  )
