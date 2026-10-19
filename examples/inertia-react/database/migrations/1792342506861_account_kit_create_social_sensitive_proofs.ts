import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('social_sensitive_proofs', (table) => {
      table.increments('id')
      table.string('hash', 64).notNullable().unique()
      table
        .integer('user_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE')
      table.string('purpose', 32).notNullable()
      table.string('credential_revision', 40).nullable()
      table.timestamp('expires_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('created_at', { useTz: true, precision: 3 }).notNullable()
      table.index(['user_id', 'purpose'])
    })
  }

  async down() {
    this.schema.dropTable('social_sensitive_proofs')
  }
}
