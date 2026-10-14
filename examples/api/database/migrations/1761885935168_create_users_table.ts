import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

export default class extends BaseSchema {
  protected tableName = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      const idType = env.get('ACCOUNT_KIT_USER_ID_TYPE') ?? 'integer'
      if (idType === 'integer') table.increments('id').notNullable()
      else if (idType === 'uuid') table.uuid('id').primary().notNullable()
      else table.string('id').primary().notNullable()
      table.string('full_name').notNullable()
      table.string('email', 254).notNullable().unique()
      table.string('password').notNullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
