import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

export default class extends BaseSchema {
  protected tableName = 'login_link_tokens'

  async up() {
    const idType = env.get('ACCOUNT_KIT_USER_ID_TYPE') ?? 'integer'
    const usersTable = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      const tokenableId =
        idType === 'integer'
          ? table.integer('tokenable_id').unsigned()
          : idType === 'uuid'
            ? table.uuid('tokenable_id')
            : table.string('tokenable_id')
      tokenableId.notNullable().unique().references('id').inTable(usersTable).onDelete('CASCADE')
      table.string('email', 254).notNullable()
      table.string('hash', 64).notNullable().unique()
      table.string('client_challenge', 43).notNullable()
      table.timestamp('expires_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('created_at', { useTz: true, precision: 3 }).notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
