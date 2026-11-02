import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

export default class extends BaseSchema {
  protected tableName = 'account_invitations'

  async up() {
    const idType = env.get('ACCOUNT_KIT_USER_ID_TYPE') ?? 'integer'
    const usersTable = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.string('email', 254).notNullable().unique()
      table.string('role', 64).notNullable()
      const inviterId =
        idType === 'integer'
          ? table.integer('inviter_id').unsigned()
          : idType === 'uuid'
            ? table.uuid('inviter_id')
            : table.string('inviter_id')
      inviterId.nullable().references('id').inTable(usersTable).onDelete('SET NULL')
      table.string('token_hash', 64).notNullable().unique()
      table.timestamp('expires_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('created_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('updated_at', { useTz: true, precision: 3 }).notNullable()
      table.index(
        ['created_at', 'id', 'expires_at'],
        'account_invitations_created_at_id_expires_at_index'
      )
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
