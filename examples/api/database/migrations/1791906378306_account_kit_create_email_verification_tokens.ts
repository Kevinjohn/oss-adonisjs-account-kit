import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('email_verification_tokens', (table) => {
      table.increments('id')
      table
        .integer('tokenable_id')
        .unsigned()
        .notNullable()
        .unique()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE')
      table.string('email', 254).notNullable()
      table.string('current_email', 254).notNullable().defaultTo('')
      table.string('purpose', 32).notNullable().defaultTo('activation')
      table.string('hash', 64).notNullable().unique()
      table.timestamp('expires_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('created_at', { useTz: true, precision: 3 }).notNullable()
    })
  }

  async down() {
    this.schema.dropTable('email_verification_tokens')
  }
}
