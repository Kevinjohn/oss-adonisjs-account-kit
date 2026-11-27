import { RuntimeException } from '@adonisjs/core/exceptions'
import type { ApplicationService } from '@adonisjs/core/types'
import { AccountKit } from '../src/account_kit.ts'
import { AccountKitCallbackConfiguration } from '../src/account_kit_callback_configuration.ts'
import { AccountKitConfigResolution, resolveAccountKitConfig } from '../src/config_resolution.ts'
import type { ManagedRoutes } from '../src/http/route_registration.ts'

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'account_kit.manager': AccountKit
    'account_kit.managed_routes': ManagedRoutes
  }
}

export default class AccountKitProvider {
  constructor(protected app: ApplicationService) {}

  register(): void {
    this.app.container.singleton(AccountKitConfigResolution, () => new AccountKitConfigResolution())
    this.app.container.singleton(
      AccountKitCallbackConfiguration,
      () => new AccountKitCallbackConfiguration()
    )
    this.app.container.singleton('account_kit.manager', async (resolver) => {
      const db = await resolver.make('lucid.db')
      const limiter = await resolver.make('limiter.manager')
      const config = await resolveAccountKitConfig(this.app)
      if (!config) {
        throw new RuntimeException(
          'Invalid "config/account_kit.ts" file. Make sure it exists and exports defineConfig(...)'
        )
      }
      return new AccountKit({ config, db, limiter })
    })
    this.app.container.singleton(AccountKit, (resolver) => resolver.make('account_kit.manager'))
    // Imported on first use: the HTTP entry needs VineJS, which service-only applications omit.
    this.app.container.singleton('account_kit.managed_routes', async () => {
      const { ManagedRoutes } = await import('../src/http/route_registration.js')
      return new ManagedRoutes()
    })
  }
}
