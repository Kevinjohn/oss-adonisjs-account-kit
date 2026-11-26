// Binds the admission service in the container from `config/account_kit.ts` and `config/admission.ts`.
import type { ApplicationService } from '@adonisjs/core/types'
import { AccountKit } from '../src/account_kit.ts'
import { resolveAccountKitConfig } from '../src/config_resolution.ts'
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from '../src/errors.ts'
import { AdmissionCallbackConfiguration } from '../src/admission/callback_configuration.ts'
import { resolveAdmissionConfig } from '../src/admission/config.ts'
import { AccountAdmission } from '../src/admission/service.ts'
import type { ResolvedAdmissionConfig } from '../src/admission/types.ts'

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'account_admission': AccountAdmission
    'account_admission.callbacks': AdmissionCallbackConfiguration
  }
}

export default class AccountAdmissionProvider {
  constructor(protected app: ApplicationService) {}

  register(): void {
    this.app.container.singleton(
      AdmissionCallbackConfiguration,
      () => new AdmissionCallbackConfiguration()
    )
    this.app.container.alias('account_admission.callbacks', AdmissionCallbackConfiguration)
    this.app.container.singleton(AccountAdmission, async (resolver) => {
      const kit = await resolver.make(AccountKit)
      const db = await resolver.make('lucid.db')
      const accountConfig = await resolveAccountKitConfig(this.app)
      const config = this.app.config.get<ResolvedAdmissionConfig | undefined>('admission')
      if (!accountConfig)
        throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
          'config/account_kit.ts',
          'Invalid "config/account_kit.ts" file. Make sure it exists and exports defineConfig(...)'
        )
      if (!config)
        throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
          'config/admission.ts',
          'Invalid "config/admission.ts" file. Make sure it exists and exports defineConfig(...)'
        )
      const registry = await resolver.make(AdmissionCallbackConfiguration)
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
