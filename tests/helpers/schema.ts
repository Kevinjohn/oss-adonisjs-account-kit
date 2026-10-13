import type { Database } from '@adonisjs/lucid/database'

export async function resetSchema(db: Database): Promise<void> {
  const schema = db.connection().schema
  await schema.dropTableIfExists('users')
  await schema.createTable('users', (table) => {
    table.increments('id').primary()
    table.string('email').notNullable().unique()
    table.string('password').nullable()
    table.timestamp('created_at').notNullable()
  })
}
