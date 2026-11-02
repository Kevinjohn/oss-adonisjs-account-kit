import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

export default class extends BaseSchema {
  static disableTransactions = true

  protected usersTable = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'

  async up() {
    this.schema.alterTable(this.usersTable, (table) => {
      table.string('full_name').nullable().alter()
    })
  }

  async down() {
    const userWithMissingName = await this.db.from(this.usersTable).whereNull('full_name').first()

    if (userWithMissingName) {
      throw new Error(
        'Cannot restore required user names while users have NULL full_name; assign names explicitly before rolling back.'
      )
    }

    this.schema.alterTable(this.usersTable, (table) => {
      table.string('full_name').notNullable().alter()
    })
  }
}
