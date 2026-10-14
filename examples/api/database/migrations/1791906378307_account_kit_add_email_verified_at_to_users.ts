import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

export default class extends BaseSchema {
  protected tableName = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.timestamp('email_verified_at', { useTz: true }).nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('email_verified_at')
    })
  }
}
