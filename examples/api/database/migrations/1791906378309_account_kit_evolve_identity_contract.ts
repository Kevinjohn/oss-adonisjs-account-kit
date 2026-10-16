import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

export default class extends BaseSchema {
  async up() {
    const usersTable = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(usersTable)) throw new Error('Invalid users table name')
    this.schema.alterTable(usersTable, (table) => {
      table.string('unverified_email', 254).nullable()
    })
    if (this.db.dialect.name === 'better-sqlite3') {
      this.defer(async (db) => {
        await db.rawQuery(`ALTER TABLE "${usersTable}" ALTER COLUMN password DROP NOT NULL`).exec()
      })
    } else {
      this.schema.alterTable(usersTable, (table) => {
        table.string('password').nullable().alter()
      })
    }
    this.schema.alterTable('password_reset_tokens', (table) => {
      table.renameColumn('user_id', 'tokenable_id')
      table.renameColumn('token_hash', 'hash')
    })
    this.schema.createTable('email_verification_tokens', (table) => {
      table.increments('id')
      const idType = env.get('ACCOUNT_KIT_USER_ID_TYPE') ?? 'integer'
      const userId =
        idType === 'integer'
          ? table.integer('tokenable_id').unsigned()
          : idType === 'uuid'
            ? table.uuid('tokenable_id')
            : table.string('tokenable_id')
      userId.notNullable().unique().references('id').inTable(usersTable).onDelete('CASCADE')
      table.string('email', 254).notNullable()
      table.string('current_email', 254).notNullable().defaultTo('')
      table.string('purpose', 32).notNullable().defaultTo('activation')
      table.string('hash', 64).notNullable().unique()
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable()
    })
    this.defer(async (db) => {
      await db
        .from(usersTable)
        .whereNull('email_verified_at')
        .update({ unverified_email: db.raw('email') })
      const changes = await db
        .from('account_email_changes')
        .where('expires_at', '>', new Date().toISOString())
      for (const change of changes) {
        const user = await db.from(usersTable).where('id', change.user_id).first()
        if (!user || user.email !== change.current_email) {
          throw new Error(
            'account_kit: email-change proof no longer matches its user; resolve it before migration'
          )
        }
        const inactive = user.email_verified_at === null
        await db
          .from(usersTable)
          .where('id', user.id)
          .update(
            inactive
              ? { email: change.new_email, unverified_email: change.new_email }
              : { unverified_email: change.new_email }
          )
        await db.table('email_verification_tokens').insert({
          tokenable_id: user.id,
          email: change.new_email,
          current_email: inactive ? change.new_email : change.current_email,
          purpose: 'email_change',
          hash: change.token_hash,
          expires_at: change.expires_at,
          created_at: change.created_at,
        })
      }
    })
  }

  async down() {
    const usersTable = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'
    this.schema.dropTable('email_verification_tokens')
    this.schema.alterTable('password_reset_tokens', (table) => {
      table.renameColumn('tokenable_id', 'user_id')
      table.renameColumn('hash', 'token_hash')
    })
    this.schema.alterTable(usersTable, (table) => {
      table.dropColumn('unverified_email')
    })
  }
}
