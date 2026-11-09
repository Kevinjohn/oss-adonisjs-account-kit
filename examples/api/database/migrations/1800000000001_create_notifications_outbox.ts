import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'account_kit_outbox'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').primary()
      table
        .integer('user_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE')
      table.string('operation').notNullable()
      table.string('operation_id', 64).notNullable().unique()
      table.string('recipient_email', 254).notNullable()
      table.integer('attempts').notNullable().defaultTo(0)
      table.timestamp('sent_at').nullable()
      table.string('last_error', 64).nullable()
      table.timestamp('created_at').notNullable().defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
