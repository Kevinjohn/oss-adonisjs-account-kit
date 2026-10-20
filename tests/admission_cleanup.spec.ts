import { test } from '@japa/runner'
import { withAdmissionCleanup } from '../src/admission/cleanup.js'
import { useAdmissionApp } from './helpers/admission_schema.js'
import { makeAdmission, writeAdmissionRow } from './helpers/admission.js'
import { insertUser, makeUsersAdapter } from './helpers/fakes.js'

test.group('admission cleanup on account deletion', (group) => {
  // Foreign keys would hide a missing explicit delete, so this group's table has none.
  const kit = useAdmissionApp(group, {}, async (app) => {
    await app.db.connection().schema.createTable('account_admissions', (table) => {
      table.increments('id')
      table.integer('user_id').notNullable().unique()
      table.timestamp('requested_at', { useTz: true, precision: 3 }).nullable()
      table.integer('invitation_id').nullable()
      table.string('invited_email', 254).nullable()
      table.string('invited_role', 64).nullable()
      table.string('invitation_source', 16).nullable()
      table.timestamp('invitation_recorded_at', { useTz: true, precision: 3 }).nullable()
      table.string('approval_status', 16).nullable()
      table.integer('approval_actor_id').nullable()
      table.timestamp('approval_decided_at', { useTz: true, precision: 3 }).nullable()
      table.timestamp('created_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('updated_at', { useTz: true, precision: 3 }).notNullable()
    })
  })

  test('removes the row and clears the actor reference before the user row goes', async ({
    assert,
  }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const order: string[] = []
    const { account } = makeAdmission(
      kit,
      { invitation: { required: true } },
      {
        enabled: ['accountDeletion'],
        authentication: { strategy: 'access_tokens', guard: 'api' },
        onAccountDeletingTransaction: withAdmissionCleanup(async () => {
          order.push('next')
        }),
        users: {
          ...users,
          async delete(id, trx) {
            order.push('delete')
            const own = await trx.from('account_admissions').where('user_id', id)
            const decided = await trx.from('account_admissions').where('approval_actor_id', id)
            assert.lengthOf(own, 0)
            assert.lengthOf(decided, 0)
            await users.delete!(id, trx)
          },
        },
      }
    )
    const approver = await insertUser(kit, { email: 'approver@example.test' })
    const subject = await insertUser(kit, { email: 'subject@example.test' })
    await writeAdmissionRow(kit, approver.id, { invited: true, approval: 'approved' })
    await writeAdmissionRow(kit, subject.id, { approval: 'approved', actorId: approver.id })

    await account.accountData.delete({ actorId: approver.id, currentPassword: 'password123' })

    assert.deepEqual(order, ['next', 'delete'])
    assert.isNull(await kit.db.from('account_admissions').where('user_id', approver.id).first())
    const kept = await kit.db.from('account_admissions').where('user_id', subject.id).first()
    assert.equal(kept.approval_status, 'approved')
    assert.isNull(kept.approval_actor_id)
  })
})
