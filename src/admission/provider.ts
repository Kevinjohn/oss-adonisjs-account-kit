// Binds the admission service in the container from `config/account_kit.ts` and `config/admission.ts`.
import type { ApplicationService } from '@adonisjs/core/types'
import { AccountKit } from '../account_kit.js'
import { resolveAccountKitConfig } from '../config_resolution.js'
import { InvalidConfigurationError } from '../errors.js'
import { AdmissionCallbackRegistry } from './callback_registry.js'
import { resolveAdmissionConfig } from './config.js'
import { AccountAdmission } from './service.js'
import type { ResolvedAdmissionConfig } from './types.js'

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'account_admission': AccountAdmission
    'account_admission.callbacks': AdmissionCallbackRegistry
  }
}

export default class AdmissionProvider {
  constructor(protected app: ApplicationService) {}

  register(): void {
    this.app.container.singleton(AdmissionCallbackRegistry, () => new AdmissionCallbackRegistry())
    this.app.container.alias('account_admission.callbacks', AdmissionCallbackRegistry)
    this.app.container.singleton(AccountAdmission, async (resolver) => {
      const kit = await resolver.make(AccountKit)
      const db = await resolver.make('lucid.db')
      const accountConfig = await resolveAccountKitConfig(this.app)
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
      const registry = await resolver.make(AdmissionCallbackRegistry)
      const callbacks = await registry.resolve()
      return new AccountAdmission({
        kit,
        db,
        accountConfig,
        config: resolveAdmissionConfig(config, callbacks),
      })
    })
    this.app.container.alias('account_admission', AccountAdmission)
  }
}
