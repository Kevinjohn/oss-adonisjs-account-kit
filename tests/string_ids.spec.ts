import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import type { UsersAdapter } from '../src/types.js'
import { bootTestApp } from './helpers/app.js'
import { accountKit, makeConfig, makeNotify, makeUsersAdapter, tokenFrom } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'
test('account workflows support string user IDs with matching application-owned foreign keys', async ({
  assert,
}) => {
  const kit = await bootTestApp()
  try {
    await resetSchema(kit, { stringUserIds: true })
    const base = makeUsersAdapter(kit.db, kit.hash)
    const users: UsersAdapter = {
      ...base,
      async create(attrs, trx) {
        const id = randomUUID()
        await trx.table('users').insert({
          id,
          email: attrs.email.trim().toLowerCase(),
          password: await kit.hash.make(attrs.password),
          email_verified_at: attrs.emailVerifiedAt.toISO(),
          created_at: DateTime.utc().toISO(),
        })
        return (await base.findById(id, trx))!
      },
    }
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
    const recorder = makeNotify()
    const account = accountKit(
      kit,
      defineConfig(makeConfig({ users, notify: recorder.notify, minRequestMs: 0 }))
    )
    const invitation = await account.invitations.send({
      actorId: actor.id,
      email: 'invited@example.test',
      role: 'member',
    })
    assert.equal(invitation.inviterId, actor.id)
    const invitationCall = recorder.calls.find((call) => call.method === 'invitation')!
    const invitationToken = tokenFrom(invitationCall.args[1])
    const invited = await account.invitations.accept({
      token: invitationToken,
      password: 'invitedPassword123',
    })
    assert.isString(invited.id)
    assert.match(String(invited.id), /^[a-f\d-]{36}$/)

    await account.recovery.request({ email: actor.email, clientKey: 'text-id-client' })
    const recoveryCall = recorder.calls.find((call) => call.method === 'recovery')!
    const recoveryToken = tokenFrom(recoveryCall.args[1])
    const reset = await account.recovery.reset({
      token: recoveryToken,
      password: 'resetPassword123',
    })
    assert.equal(reset.id, actor.id)
    await account.credentials.requestEmailChange({
      actorId: actor.id,
      currentPassword: 'resetPassword123',
      newEmail: 'changed@example.test',
    })
    const emailCall = recorder.calls.find((call) => call.method === 'emailChangeConfirm')!
    const emailToken = tokenFrom(emailCall.args[2])
    const changed = await account.credentials.completeEmailChange({ token: emailToken })
    assert.equal(changed.id, actor.id)
    assert.equal(changed.email, 'changed@example.test')
    await kit.db.from('users').where('id', actor.id).delete()
    assert.lengthOf(await kit.db.from('account_recovery_tokens'), 0)
    assert.lengthOf(await kit.db.from('account_email_changes'), 0)
  } finally {
    await kit.close()
  }
})
