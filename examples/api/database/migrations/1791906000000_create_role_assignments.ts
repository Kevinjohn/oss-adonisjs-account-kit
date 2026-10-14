import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

export default class extends BaseSchema {
  protected tableName = 'role_assignments'
  protected usersTable = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').primary()
      const idType = env.get('ACCOUNT_KIT_USER_ID_TYPE') ?? 'integer'
      const userId =
        idType === 'integer'
          ? table.integer('user_id')
          : idType === 'uuid'
            ? table.uuid('user_id')
            : table.string('user_id')
      userId.notNullable().references(`${this.usersTable}.id`).onDelete('CASCADE')
      table.string('role').notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
