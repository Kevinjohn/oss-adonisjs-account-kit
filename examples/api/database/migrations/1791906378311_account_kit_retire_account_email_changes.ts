import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

export default class extends BaseSchema {
  async up() {
    this.schema.dropTable('account_email_changes')
  }

  async down() {
    this.schema.createTable('account_email_changes', (table) => {
      table.increments('id')
      const idType = env.get('ACCOUNT_KIT_USER_ID_TYPE') ?? 'integer'
      const usersTable = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'
      const userId =
        idType === 'integer'
          ? table.integer('user_id').unsigned()
          : idType === 'uuid'
            ? table.uuid('user_id')
            : table.string('user_id')
      userId.notNullable().unique().references('id').inTable(usersTable).onDelete('CASCADE')
      table.string('current_email', 254).notNullable()
      table.string('new_email', 254).notNullable()
      table.string('token_hash', 64).notNullable().unique()
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable()
    })
  }
}
