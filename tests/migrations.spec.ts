import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
test.group('published account kit migrations', (group) => {
  const kit = useTestApp(group)

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
    if (kit.db.connection().dialect.name === 'better-sqlite3') {
      const invitationIndexes = await kit.db
        .rawQuery("PRAGMA index_list('account_invitations')")
        .exec()
      assert.isTrue(
        invitationIndexes.some(
          (index: { name: string }) =>
            index.name === 'account_invitations_created_at_id_expires_at_index'
        )
      )
    }
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

  test('indexes invitation listing in timestamp and id order', async ({ assert }) => {
    if (kit.db.connection().dialect.name !== 'better-sqlite3') return
    const now = new Date().toISOString()
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      email: `person${index}@example.test`,
      role: 'member',
      token_hash: `${index}`.padStart(64, '0'),
      expires_at: index % 2 === 0 ? '2999-01-01T00:00:00.000Z' : '2000-01-01T00:00:00.000Z',
      created_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      updated_at: now,
    }))
    for (let index = 0; index < rows.length; index += 100) {
      await kit.db.table('account_invitations').insert(rows.slice(index, index + 100))
    }

    const plan = await kit.db
      .rawQuery(
        'EXPLAIN QUERY PLAN SELECT * FROM account_invitations WHERE expires_at > ? ORDER BY created_at ASC, id ASC LIMIT 26',
        [now]
      )
      .exec()
    const details = plan.map((step: { detail: string }) => step.detail).join(' ')

    assert.include(details, 'account_invitations_created_at_id_expires_at_index')
    assert.notInclude(details, 'USE TEMP B-TREE FOR ORDER BY')
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
