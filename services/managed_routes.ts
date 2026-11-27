import app from '@adonisjs/core/services/app'
import type { ManagedRoutes } from '../src/http/route_registration.ts'

let managedRoutes: ManagedRoutes
await app.booted(async () => {
  managedRoutes = await app.container.make('account_kit.managed_routes')
})
export { managedRoutes as default }
