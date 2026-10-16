import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

export default class extends BaseSchema {
  async up() {
    const usersTable = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'
    const addUserId = (table: Parameters<Parameters<typeof this.schema.createTable>[1]>[0]) => {
      const kind = env.get('ACCOUNT_KIT_USER_ID_TYPE') ?? 'integer'
      return kind === 'integer'
        ? table.integer('user_id').unsigned()
        : kind === 'uuid'
          ? table.uuid('user_id')
          : table.string('user_id')
    }
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
      addUserId(table).nullable().references('id').inTable(usersTable).onDelete('CASCADE')
      table.string('provider_user_id', 255).nullable()
      table.string('email', 254).nullable()
      table.boolean('email_verified').nullable()
      table.string('name', 255).nullable()
      table.string('nickname', 255).nullable()
      table.string('avatar_url', 2048).nullable()
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable()
    })
    this.schema.createTable('social_sensitive_proofs', (table) => {
      table.increments('id')
      table.string('hash', 64).notNullable().unique()
      addUserId(table).notNullable().references('id').inTable(usersTable).onDelete('CASCADE')
      table.string('purpose', 32).notNullable()
      table.string('credential_revision', 40).nullable()
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable()
      table.index(['user_id', 'purpose'])
    })
    this.schema.createTable('social_handoff_codes', (table) => {
      table.increments('id')
      table.string('hash', 64).notNullable().unique()
      addUserId(table).notNullable().references('id').inTable(usersTable).onDelete('CASCADE')
      table
        .integer('social_identity_id')
        .notNullable()
        .references('id')
        .inTable('social_identities')
        .onDelete('CASCADE')
      table.string('credential_revision', 40).nullable()
      table.string('client_challenge', 43).notNullable()
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable()
    })
  }

  async down() {
    this.schema.dropTable('social_handoff_codes')
    this.schema.dropTable('social_sensitive_proofs')
    this.schema.dropTable('social_transactions')
  }
}
