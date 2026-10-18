import type { TestApp } from './app.js'

/**
 * A users table owned by another ORM: canonical columns, database defaults for everything the
 * adapter does not write, and an application column for registration data.
 */
export async function createAppUsersTable(
  kit: TestApp,
  table: string,
  options: { stringIds?: boolean } = {}
): Promise<void> {
  const schema = kit.db.connection().schema
  await schema.dropTableIfExists(table)
  await schema.createTable(table, (builder) => {
    if (options.stringIds) builder.string('id', 36).primary()
    else builder.increments('id')
    builder.string('email', 254).notNullable().unique()
    builder.string('unverified_email', 254).nullable()
    builder.string('password').nullable()
    builder.timestamp('email_verified_at', { useTz: true }).nullable()
    builder.timestamp('credentials_changed_at', { useTz: true }).nullable()
    builder.string('full_name').nullable()
    builder.string('role').nullable()
    builder
      .timestamp('created_at', { useTz: true })
      .notNullable()
      .defaultTo(kit.db.connection().getWriteClient().fn.now())
  })
}
