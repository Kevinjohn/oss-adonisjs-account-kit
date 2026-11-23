import { RuntimeException } from '@adonisjs/core/exceptions'
import type { ApplicationService } from '@adonisjs/core/types'
import { AccountKit } from '../src/account_kit.js'
import { AccountKitCallbackRegistry } from '../src/callback_registry.js'
import { resolveAccountKitConfig } from '../src/config_resolution.js'

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'account_kit': AccountKit
    'account_kit.callbacks': AccountKitCallbackRegistry
  }
}

export default class AccountKitProvider {
  constructor(protected app: ApplicationService) {}

  register(): void {
    this.app.container.singleton(AccountKitCallbackRegistry, () => new AccountKitCallbackRegistry())
    this.app.container.alias('account_kit.callbacks', AccountKitCallbackRegistry)
    this.app.container.singleton(AccountKit, async (resolver) => {
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
    this.app.container.alias('account_kit', AccountKit)
  }
}
