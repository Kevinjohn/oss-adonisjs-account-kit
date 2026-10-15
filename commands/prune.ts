import { BaseCommand, flags } from '@adonisjs/core/ace'
import { pruneExpired } from '../src/maintenance.js'

export default class PruneAccountKit extends BaseCommand {
  static commandName = 'account-kit:prune'
  static description = 'Remove expired password-reset, invitation, and email-change rows'
  static options = { startApp: true }

  @flags.number({ description: 'Maximum rows inspected in each batch (1–1000)' })
  declare batchSize?: number

  @flags.number({ description: 'Maximum batches scanned in one run (1–1000)' })
  declare maxBatches?: number

  @flags.boolean({ description: 'Count expired rows without deleting them' })
  declare dryRun: boolean

  async run(): Promise<void> {
    const db = await this.app.container.make('lucid.db')
    const counts = await pruneExpired(db, {
      batchSize: this.batchSize,
      maxBatches: this.maxBatches,
      dryRun: this.dryRun,
    })
    const action = this.dryRun ? 'Expired' : 'Pruned'
    this.logger.info(
      `${action}: recovery=${counts.recovery}, invitations=${counts.invitations}, emailChanges=${counts.emailChanges}`
    )
  }
}
