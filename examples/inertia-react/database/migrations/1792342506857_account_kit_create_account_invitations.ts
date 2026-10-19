import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('account_invitations', (table) => {
      table.increments('id')
      table.string('email', 254).notNullable().unique()
      table.string('role', 64).notNullable()
      table
        .integer('inviter_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
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
    this.schema.dropTable('account_invitations')
  }
}
