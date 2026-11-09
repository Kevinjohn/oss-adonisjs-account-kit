import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected usersTable = 'users'

  // Change only the constraint, in place. `.alter()` would also reset the column's type and
  // default, and on SQLite it rebuilds the users table. The table name is a plain identifier.
  async up() {
    this.defer(async (db) => {
      await db
        .rawQuery(`ALTER TABLE "${this.usersTable}" ALTER COLUMN full_name DROP NOT NULL`)
        .exec()
    })
  }

  async down() {
    const userWithMissingName = await this.db.from(this.usersTable).whereNull('full_name').first()

    if (userWithMissingName) {
      throw new Error(
        'Cannot restore required user names while users have NULL full_name; assign names explicitly before rolling back.'
      )
    }

    this.defer(async (db) => {
      await db
        .rawQuery(`ALTER TABLE "${this.usersTable}" ALTER COLUMN full_name SET NOT NULL`)
        .exec()
    })
  }
}
