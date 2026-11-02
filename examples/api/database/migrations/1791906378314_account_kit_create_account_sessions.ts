import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

export default class extends BaseSchema {
  protected tableName = 'account_sessions'

  async up() {
    const idType = env.get('ACCOUNT_KIT_USER_ID_TYPE') ?? 'integer'
    const usersTable = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      const userId =
        idType === 'integer'
          ? table.integer('user_id').unsigned()
          : idType === 'uuid'
            ? table.uuid('user_id')
            : table.string('user_id')
      userId.notNullable().index().references('id').inTable(usersTable).onDelete('CASCADE')
      table.string('handle_hash', 64).notNullable().unique()
      table.string('label', 255).nullable()
      table.timestamp('created_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('last_seen_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('expires_at', { useTz: true, precision: 3 }).notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
