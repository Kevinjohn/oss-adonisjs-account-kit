import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

export default class extends BaseSchema {
  protected tableName = 'auth_access_tokens'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      const idType = env.get('ACCOUNT_KIT_USER_ID_TYPE') ?? 'integer'
      const usersTable = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'
      const userId =
        idType === 'integer'
          ? table.integer('tokenable_id').unsigned()
          : idType === 'uuid'
            ? table.uuid('tokenable_id')
            : table.string('tokenable_id')
      userId.notNullable().references('id').inTable(usersTable).onDelete('CASCADE')

      table.string('type').notNullable()
      table.string('name').nullable()
      table.string('hash').notNullable()
      table.text('abilities').notNullable()
      table.timestamp('created_at')
      table.timestamp('updated_at')
      table.timestamp('last_used_at').nullable()
      table.timestamp('expires_at').nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
