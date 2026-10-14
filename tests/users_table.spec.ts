import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { EmailAlreadyRegisteredError } from '../src/errors.js'
import { bootTestApp } from './helpers/app.js'
import { makeService, makeUsersAdapter, tokenFrom } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'

const tableNames = ['accounts', 'order', `accounts_${'a'.repeat(45)}`, `accounts_${'b'.repeat(53)}`]

for (const usersTable of tableNames) {
  test(`account operations use the configured ${usersTable} table and its owned migrations`, async ({
    assert,
  }) => {
    const kit = await bootTestApp()
    try {
      await resetSchema(kit, { usersTable })
      assert.isFalse(await kit.db.connection().schema.hasTable('users'))
      const users = makeUsersAdapter(kit.db, kit.hash, usersTable)
      const actor = await kit.db.transaction((trx) =>
        users.create(
          {
            email: 'actor@example.test',
            password: 'originalPassword123',
            emailVerifiedAt: DateTime.utc(),
          },
          trx
        )
      )
      const { account, recorder } = makeService(kit, { users, usersTable, minRequestMs: 0 })

      await kit.db.from(usersTable).where('id', actor.id).update({ email_verified_at: null })
      await account.verification.send({ userId: actor.id })
      const verificationToken = tokenFrom(recorder.calls.at(-1)!.args[1])
      assert.equal(await account.verification.complete({ token: verificationToken }), 'verified')

      await account.invitations.send({
        actorId: actor.id,
        email: 'invited@example.test',
        role: 'member',
      })
      const invitationToken = tokenFrom(recorder.calls.at(-1)!.args[1])
      const invited = await account.invitations.accept({
        token: invitationToken,
        password: 'invitedPassword123',
      })
      assert.equal(invited.email, 'invited@example.test')

      await account.recovery.request({ email: actor.email, clientKey: 'custom-table-client' })
      const recoveryToken = tokenFrom(recorder.calls.at(-1)!.args[1])
      const reset = await account.recovery.reset({
        token: recoveryToken,
        password: 'resetPassword123',
      })
      assert.equal(reset.id, actor.id)
      await account.credentials.changePassword({
        actorId: actor.id,
        currentPassword: 'resetPassword123',
        newPassword: 'changedPassword123',
      })
      await account.credentials.requestEmailChange({
        actorId: actor.id,
        currentPassword: 'changedPassword123',
        newEmail: 'next@example.test',
      })
      const emailToken = tokenFrom(recorder.calls.at(-1)!.args[2])
      const changed = await account.credentials.completeEmailChange({ token: emailToken })
      assert.equal(changed.email, 'next@example.test')

      // Registration wins after the precheck but before setEmail. The real unique
      // violation must map to the public conflict, including PostgreSQL's name limit.
      const { account: racing, recorder: raceRecorder } = makeService(kit, {
        usersTable,
        minRequestMs: 0,
        users: {
          ...users,
          async setEmail(id, email, trx) {
            await trx
              .table(usersTable)
              .insert({ email, password: null, created_at: DateTime.utc().toISO() })
            await users.setEmail(id, email, trx)
          },
        },
      })
      await racing.credentials.requestEmailChange({
        actorId: actor.id,
        currentPassword: 'changedPassword123',
        newEmail: 'race@example.test',
      })
      const raceToken = tokenFrom(raceRecorder.calls.at(-1)!.args[2])
      await assert.rejects(
        () => racing.credentials.completeEmailChange({ token: raceToken }),
        EmailAlreadyRegisteredError
      )
      const restored = await users.findById(actor.id)
      assert.equal(restored!.email, 'next@example.test')
      assert.isNull(await users.findByEmail('race@example.test'))
      assert.lengthOf(await kit.db.from('account_email_changes'), 1)
    } finally {
      try {
        await resetSchema(kit)
        await kit.db.connection().schema.dropTableIfExists(usersTable)
      } finally {
        await kit.close()
      }
    }
  })
}
