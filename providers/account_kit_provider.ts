import { Encryption } from '@adonisjs/core/encryption'
import type { ApplicationService } from '@adonisjs/core/types'
import { AccountKit } from '../src/account_kit.js'
import type { ResolvedConfig } from '../src/types.js'

export default class AccountKitProvider {
  constructor(protected app: ApplicationService) {}

  register(): void {
    this.app.container.singleton(AccountKit, async (resolver) => {
      const db = await resolver.make('lucid.db')
      const encryption = await resolver.make(Encryption)
      const limiter = await resolver.make('limiter.manager')
      const config = this.app.config.get<ResolvedConfig>('account_kit')
      return new AccountKit({ config, db, encryption, limiter })
    })
  }
}
