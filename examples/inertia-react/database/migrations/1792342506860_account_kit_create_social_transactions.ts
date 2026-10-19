import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('social_transactions', (table) => {
      table.increments('id')
      table.string('hash', 64).notNullable().unique()
      table.string('provider', 64).notNullable()
      table.string('intent', 16).notNullable()
      table.string('purpose', 32).nullable()
      table.string('client_challenge', 43).notNullable()
      table.string('verification_hash', 64).nullable()
      table.string('proof_hash', 64).nullable()
      table.string('credential_revision', 40).nullable()
      table
        .integer('user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE')
      table.string('provider_user_id', 255).collate('utf8mb4_0900_bin').nullable()
      table.string('email', 254).nullable()
      table.boolean('email_verified').nullable()
      table.string('name', 255).nullable()
      table.string('nickname', 255).nullable()
      table.string('avatar_url', 2048).nullable()
      table.timestamp('expires_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('created_at', { useTz: true, precision: 3 }).notNullable()
    })
  }

  async down() {
    this.schema.dropTable('social_transactions')
  }
}
