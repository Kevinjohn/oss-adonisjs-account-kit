import { BaseCommand, flags } from '@adonisjs/core/ace'
import { runDoctor } from '../src/doctor.ts'
import { resolveAccountKitConfig } from '../src/config_resolution.ts'

export default class AccountKitDoctor extends BaseCommand {
  static commandName = 'account-kit:doctor'
  static description = 'Check config, limiter, backend origin and database tables for Account Kit'
  static options = { startApp: true }

  @flags.string({ description: 'Backend origin if config omits it' })
  declare appUrl?: string

  async run(): Promise<void> {
    const config = await resolveAccountKitConfig(this.app)
    const checks = await runDoctor({
      config,
      db: await this.app.container.make('lucid.db'),
      limiterBound: this.app.container.hasBinding('limiter.manager'),
      appUrl: this.appUrl,
      environment: this.app.inProduction ? 'production' : this.app.inTest ? 'test' : 'development',
    })
    for (const check of checks) {
      if (check.ok) this.logger.success(`${check.name}: ${check.detail}`)
      else this.logger.error(`${check.name}: ${check.detail}${check.fix ? `. ${check.fix}` : ''}`)
    }
    if (checks.some((check) => !check.ok)) {
      this.exitCode = 1
      return
    }
    this.logger.info(
      'Unverified: notification callbacks and delivery, credential revocation, and application policy and routes were not exercised.'
    )
    this.logger.info(
      config?.enabled.includes('passwordReset')
        ? 'Smoke test: request and complete a password reset in a disposable account, then check that old credentials fail.'
        : 'Smoke test: use a disposable account to exercise an enabled service operation or application route and verify its callbacks and access policy.'
    )
  }
}
