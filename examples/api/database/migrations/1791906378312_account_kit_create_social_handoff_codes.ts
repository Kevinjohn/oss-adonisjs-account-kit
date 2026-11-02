import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

export default class extends BaseSchema {
  protected tableName = 'social_handoff_codes'

  async up() {
    const idType = env.get('ACCOUNT_KIT_USER_ID_TYPE') ?? 'integer'
    const usersTable = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.string('hash', 64).notNullable().unique()
      const userId =
        idType === 'integer'
          ? table.integer('user_id').unsigned()
          : idType === 'uuid'
            ? table.uuid('user_id')
            : table.string('user_id')
      userId.notNullable().references('id').inTable(usersTable).onDelete('CASCADE')
      table
        .integer('social_identity_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('social_identities')
        .onDelete('CASCADE')
      table.string('credential_revision', 40).nullable()
      table.string('client_challenge', 43).notNullable()
      table.timestamp('expires_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('created_at', { useTz: true, precision: 3 }).notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
