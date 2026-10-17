import { RuntimeException } from '@adonisjs/core/exceptions'
import type { ApplicationService } from '@adonisjs/core/types'
import { AccountKit } from '../src/account_kit.js'
import type { ResolvedConfig } from '../src/types.js'

export default class AccountKitProvider {
  constructor(protected app: ApplicationService) {}

  register(): void {
    this.app.container.singleton(AccountKit, async (resolver) => {
      const db = await resolver.make('lucid.db')
      const limiter = await resolver.make('limiter.manager')
      const config = this.app.config.get<ResolvedConfig | undefined>('account_kit')
      if (!config) {
        throw new RuntimeException(
          'Invalid "config/account_kit.ts" file. Make sure it exists and exports defineConfig(...)'
        )
      }
      return new AccountKit({ config, db, limiter })
    })
  }
}
