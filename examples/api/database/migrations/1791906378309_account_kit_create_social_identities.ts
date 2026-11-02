import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

export default class extends BaseSchema {
  protected tableName = 'social_identities'

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
      userId.notNullable().references('id').inTable(usersTable).onDelete('CASCADE')
      table.string('provider', 64).notNullable()
      table.string('provider_user_id', 255).collate('utf8mb4_0900_bin').notNullable()
      table.string('email', 254).nullable()
      table.boolean('email_verified').notNullable().defaultTo(false)
      table.string('name', 255).nullable()
      table.string('nickname', 255).nullable()
      table.string('avatar_url', 2048).nullable()
      table.json('meta').nullable()
      table.timestamp('created_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('updated_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('confirmed_at', { useTz: true, precision: 3 }).nullable()
      table.unique(['provider', 'provider_user_id'])
      table.index(['user_id'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
