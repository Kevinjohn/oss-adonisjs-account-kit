import { test } from '@japa/runner'
import { bootTestApp } from './helpers/app.js'
import { resetSchema } from './helpers/schema.js'

test.group('published account kit migrations', (group) => {
  let kit: Awaited<ReturnType<typeof bootTestApp>>

  group.setup(async () => {
    kit = await bootTestApp()
  })

  group.each.setup(async () => {
    await resetSchema(kit)
    await kit.limiter.clear()
  })

  group.teardown(async () => {
    await kit.close()
  })

  test('creates the package tables and nullable user verification timestamp', async ({
    assert,
  }) => {
    const userColumns = await kit.db.connection().columnsInfo('users')
    assert.isTrue(userColumns.email_verified_at.nullable)

    const recoveryColumnInfo = await kit.db.connection().columnsInfo('account_recovery_tokens')
    const recoveryColumns = Object.keys(recoveryColumnInfo)
    assert.deepEqual(recoveryColumns, [
      'id',
      'user_id',
      'email',
      'token_hash',
      'expires_at',
      'created_at',
    ])
    const invitationColumnInfo = await kit.db.connection().columnsInfo('account_invitations')
    const invitationColumns = Object.keys(invitationColumnInfo)
    assert.deepEqual(invitationColumns, [
      'id',
      'email',
      'role',
      'inviter_id',
      'token_hash',
      'expires_at',
      'created_at',
      'updated_at',
    ])
    const emailChangeColumnInfo = await kit.db.connection().columnsInfo('account_email_changes')
    const emailChangeColumns = Object.keys(emailChangeColumnInfo)
    assert.deepEqual(emailChangeColumns, [
      'id',
      'user_id',
      'current_email',
      'new_email',
      'token_hash',
      'expires_at',
      'created_at',
    ])
  })

  test('enforces unique keys and the configured user deletion rules', async ({ assert }) => {
    const now = new Date().toISOString()
    const [firstUser] = await kit.db
      .table('users')
      .insert({ email: 'first@example.test', created_at: now })
      .returning('id')
    const [secondUser] = await kit.db
      .table('users')
      .insert({ email: 'second@example.test', created_at: now })
      .returning('id')
    const firstUserId = typeof firstUser === 'object' ? firstUser.id : firstUser
    const secondUserId = typeof secondUser === 'object' ? secondUser.id : secondUser

    await kit.db.table('account_recovery_tokens').insert({
      user_id: firstUserId,
      email: 'first@example.test',
      token_hash: 'a'.repeat(64),
      expires_at: now,
      created_at: now,
    })
    await kit.db.table('account_invitations').insert({
      email: 'invite@example.test',
      role: 'member',
      inviter_id: firstUserId,
      token_hash: 'b'.repeat(64),
      expires_at: now,
      created_at: now,
      updated_at: now,
    })
    await kit.db.table('account_email_changes').insert({
      user_id: firstUserId,
      current_email: 'first@example.test',
      new_email: 'next@example.test',
      token_hash: 'c'.repeat(64),
      expires_at: now,
      created_at: now,
    })

    await assert.rejects(() =>
      kit.db.table('account_recovery_tokens').insert({
        user_id: firstUserId,
        email: 'first@example.test',
        token_hash: 'd'.repeat(64),
        expires_at: now,
        created_at: now,
      })
    )
    await assert.rejects(() =>
      kit.db.table('account_email_changes').insert({
        user_id: firstUserId,
        current_email: 'first@example.test',
        new_email: 'another@example.test',
        token_hash: 'e'.repeat(64),
        expires_at: now,
        created_at: now,
      })
    )

    await assert.rejects(() =>
      kit.db.table('account_recovery_tokens').insert({
        user_id: secondUserId,
        email: 'second@example.test',
        token_hash: 'a'.repeat(64),
        expires_at: now,
        created_at: now,
      })
    )
    await assert.rejects(() =>
      kit.db.table('account_invitations').insert({
        email: 'invite@example.test',
        role: 'member',
        inviter_id: secondUserId,
        token_hash: 'd'.repeat(64),
        expires_at: now,
        created_at: now,
        updated_at: now,
      })
    )
    await assert.rejects(() =>
      kit.db.table('account_invitations').insert({
        email: 'another-invite@example.test',
        role: 'member',
        inviter_id: secondUserId,
        token_hash: 'b'.repeat(64),
        expires_at: now,
        created_at: now,
        updated_at: now,
      })
    )
    await assert.rejects(() =>
      kit.db.table('account_email_changes').insert({
        user_id: secondUserId,
        current_email: 'second@example.test',
        new_email: 'next@example.test',
        token_hash: 'c'.repeat(64),
        expires_at: now,
        created_at: now,
      })
    )

    await kit.db.from('users').where('id', firstUserId).delete()
    assert.isNull(
      await kit.db.from('account_recovery_tokens').where('user_id', firstUserId).first()
    )
    assert.isNull(await kit.db.from('account_email_changes').where('user_id', firstUserId).first())
    const invitation = await kit.db
      .from('account_invitations')
      .where('email', 'invite@example.test')
      .first()
    assert.isNull(invitation.inviter_id)
  })
})
