import { BaseCommand } from '@adonisjs/core/ace'
import { runDoctor } from '../src/doctor.js'
import type { ResolvedConfig } from '../src/types.js'

export default class AccountKitDoctor extends BaseCommand {
  static commandName = 'account-kit:doctor'
  static description = 'Check config, limiter, APP_URL and database tables for Account Kit'
  static options = { startApp: true }

  async run(): Promise<void> {
    const checks = await runDoctor({
      config: this.app.config.get<ResolvedConfig | undefined>('account_kit'),
      db: await this.app.container.make('lucid.db'),
      limiterBound: this.app.container.hasBinding('limiter.manager'),
      appUrl: process.env.APP_URL,
      environment: this.app.inProduction ? 'production' : this.app.inTest ? 'test' : 'development',
    })
    for (const check of checks) {
      if (check.ok) this.logger.success(`${check.name}: ${check.detail}`)
      else this.logger.error(`${check.name}: ${check.detail}${check.fix ? `. ${check.fix}` : ''}`)
    }
    if (checks.some((check) => !check.ok)) this.exitCode = 1
  }
}
