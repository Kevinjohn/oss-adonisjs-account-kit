// Binds the admission service in the container from `config/account_kit.ts` and `config/admission.ts`.
import type { ApplicationService } from '@adonisjs/core/types'
import { AccountKit } from '../account_kit.js'
import { InvalidConfigurationError } from '../errors.js'
import type { ResolvedConfig } from '../types.js'
import { AccountAdmission } from './service.js'
import type { ResolvedAdmissionConfig } from './types.js'

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    account_admission: AccountAdmission
  }
}

export default class AdmissionProvider {
  constructor(protected app: ApplicationService) {}

  register(): void {
    this.app.container.singleton(AccountAdmission, async (resolver) => {
      const kit = await resolver.make(AccountKit)
      const db = await resolver.make('lucid.db')
      const accountConfig = this.app.config.get<ResolvedConfig | undefined>('account_kit')
      const config = this.app.config.get<ResolvedAdmissionConfig | undefined>('admission')
      if (!accountConfig)
        throw new InvalidConfigurationError(
          'config/account_kit.ts',
          'Invalid "config/account_kit.ts" file. Make sure it exists and exports defineConfig(...)'
        )
      if (!config)
        throw new InvalidConfigurationError(
          'config/admission.ts',
          'Invalid "config/admission.ts" file. Make sure it exists and exports defineAdmission(...)'
        )
      return new AccountAdmission({ kit, db, accountConfig, config })
    })
    this.app.container.alias('account_admission', AccountAdmission)
  }
}
