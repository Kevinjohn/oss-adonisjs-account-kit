import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

export default class extends BaseSchema {
  protected usersTable = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'

  async up() {
    const quotedUsersTable = this.usersTable.replaceAll('"', '""')
    this.schema.alterTable(this.usersTable, (table) => {
      table.timestamp('email_verified_at', { useTz: true, precision: 3 }).nullable()
      table.string('unverified_email', 254).nullable()
      // Milliseconds: two credential changes within one second must give different revisions.
      table.timestamp('credentials_changed_at', { useTz: true, precision: 3 }).nullable()
    })
    if (this.db.dialect.name === 'better-sqlite3') {
      this.defer(async (db) => {
        await db
          .rawQuery(`ALTER TABLE "${quotedUsersTable}" ALTER COLUMN password DROP NOT NULL`)
          .exec()
      })
    } else {
      this.schema.alterTable(this.usersTable, (table) => {
        table.string('password').nullable().alter()
      })
    }
  }

  async down() {
    this.schema.alterTable(this.usersTable, (table) => {
      table.dropColumn('credentials_changed_at')
      table.dropColumn('unverified_email')
      table.dropColumn('email_verified_at')
    })
  }
}
