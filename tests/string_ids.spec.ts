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
          password: attrs.password === null ? null : await kit.hash.make(attrs.password),
          unverified_email: attrs.unverifiedEmail,
          email_verified_at: null,
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
          unverifiedEmail: null,
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
    const invitationCall = recorder.calls.find((call) => call.method === 'invitationProvision')!
    const invitationToken = tokenFrom(invitationCall.args[1])
    const invited = await account.invitations.accept({
      token: invitationToken,
      password: 'invitedPassword123',
    })
    assert.isString(invited.id)
    assert.match(String(invited.id), /^[a-f\d-]{36}$/)

    await account.passwordReset.request({ email: actor.email, clientKey: 'text-id-client' })
    const recoveryCall = recorder.calls.find((call) => call.method === 'passwordResetProvision')!
    const recoveryToken = tokenFrom(recoveryCall.args[1])
    const reset = await account.passwordReset.reset({
      token: recoveryToken,
      password: 'resetPassword123',
    })
    assert.equal(reset.id, actor.id)
    await account.emailPasswordManagement.requestEmailChange({
      actorId: actor.id,
      currentPassword: 'resetPassword123',
      newEmail: 'changed@example.test',
    })
    const emailCall = recorder.calls.find((call) => call.method === 'emailChangeProvision')!
    const emailToken = tokenFrom(emailCall.args[2])
    const changed = await account.emailPasswordManagement.completeEmailChange({ token: emailToken })
    assert.equal(changed.id, actor.id)
    assert.equal(changed.email, 'changed@example.test')
    await kit.db.from('users').where('id', actor.id).delete()
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
  } finally {
    await kit.close()
  }
})
