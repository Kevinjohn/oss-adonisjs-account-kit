import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('social_identities', (table) => {
      table.increments('id')
      table
        .integer('user_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE')
      table.string('provider', 64).notNullable()
      table.string('provider_user_id', 255).notNullable()
      table.string('email', 254).nullable()
      table.boolean('email_verified').notNullable().defaultTo(false)
      table.string('name', 255).nullable()
      table.string('nickname', 255).nullable()
      table.string('avatar_url', 2048).nullable()
      table.json('meta').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
      table.unique(['provider', 'provider_user_id'])
      table.index(['user_id'])
    })
  }

  async down() {
    this.schema.dropTable('social_identities')
  }
}
