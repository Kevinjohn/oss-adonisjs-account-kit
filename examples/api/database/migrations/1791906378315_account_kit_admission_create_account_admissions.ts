import { BaseSchema } from '@adonisjs/lucid/schema'
import env from '#start/env'

export default class extends BaseSchema {
  protected tableName = 'account_admissions'

  async up() {
    const idType = env.get('ACCOUNT_KIT_USER_ID_TYPE') ?? 'integer'
    const usersTable = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      // Null only on a bootstrap approval waiting for its account.
      const userId =
        idType === 'integer'
          ? table.integer('user_id').unsigned()
          : idType === 'uuid'
            ? table.uuid('user_id')
            : table.string('user_id')
      userId.nullable().unique().references('id').inTable(usersTable).onDelete('CASCADE')
      table.string('bootstrap_email', 254).nullable().unique()
      table.timestamp('requested_at', { useTz: true, precision: 3 }).nullable()
      // The consumed account_invitations id. No foreign key: acceptance deletes that row.
      table.integer('invitation_id').nullable()
      table.string('invited_email', 254).nullable()
      table.string('invited_role', 64).nullable()
      table.string('invitation_source', 16).nullable()
      table.timestamp('invitation_recorded_at', { useTz: true, precision: 3 }).nullable()
      table.string('approval_status', 16).nullable()
      const approvalActorId =
        idType === 'integer'
          ? table.integer('approval_actor_id').unsigned()
          : idType === 'uuid'
            ? table.uuid('approval_actor_id')
            : table.string('approval_actor_id')
      approvalActorId.nullable().references('id').inTable(usersTable).onDelete('SET NULL')
      table.timestamp('approval_decided_at', { useTz: true, precision: 3 }).nullable()
      table.timestamp('created_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('updated_at', { useTz: true, precision: 3 }).notNullable()
      table.index(['created_at', 'id'], 'account_admissions_created_at_id_index')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
