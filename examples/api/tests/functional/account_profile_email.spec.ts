/* eslint-disable @unicorn/no-await-expression-member -- Inline awaited requests keep each assertion tied to the HTTP operation it verifies. */

import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'
import { tokenFrom } from '#tests/helpers/link_tokens'
import { truncateDatabase } from '#tests/helpers/database'

test.group('Account profile email', (group) => {
  group.each.setup(truncateDatabase)

  test('profile email change over HTTP confirms the new address and revokes tokens', async ({
    client,
    assert,
  }) => {
    notifications.reset()

    const emailUser = await User.create({
      fullName: 'Email User',
      email: 'old-address@example.test',
      password: 'EmailPass123!',
      emailVerifiedAt: DateTime.utc(),
    })
    await User.accessTokens.create(emailUser)
    assert.equal(
      Number(
        (
          await db
            .from('auth_access_tokens')
            .where('tokenable_id', emailUser.id)
            .count('* as count')
            .first()
        ).count
      ),
      1
    )
    const emailRequest = await client.patch('/api/v1/account/profile').loginAs(emailUser).json({
      currentPassword: 'EmailPass123!',
      email: 'New-Address@example.test',
    })
    assert.equal(emailRequest.status(), 200)
    const emailNotice = notifications.events.find((event) => event.kind === 'emailChangeConfirm')!
    assert.equal(emailNotice.recipient, 'new-address@example.test')
    const emailToken = tokenFrom(emailNotice.value)
    const emailPath = `/api/v1/auth/email-change/${encodeURIComponent(emailToken)}`
    const emailInspect = await client.get(emailPath)
    assert.equal(emailInspect.header('referrer-policy'), 'no-referrer')
    assert.equal(emailInspect.header('cache-control'), 'no-store')
    await emailUser.refresh()
    assert.equal(emailUser.email, 'old-address@example.test')
    const emailComplete = await client.post(emailPath).json({})
    assert.equal(emailComplete.status(), 200)
    assert.equal((emailComplete.body() as { email: string }).email, 'new-address@example.test')
    assert.equal((emailComplete.body() as { verified: boolean }).verified, true)
    assert.equal((await client.get(emailPath)).status(), 400)
    assert.equal(notifications.events.filter((event) => event.kind === 'emailChanged').length, 1)
    assert.equal(
      notifications.events.find((event) => event.kind === 'emailChanged')!.recipient,
      'old-address@example.test'
    )
    const emailChangeOutbox = await db
      .from('account_kit_outbox')
      .where('user_id', emailUser.id)
      .where('operation', 'email_change')
      .first()
    assert.isNull(emailChangeOutbox)
    assert.equal((await client.post(emailPath).json({})).status(), 400)
    assert.equal(
      Number(
        (
          await db
            .from('auth_access_tokens')
            .where('tokenable_id', emailUser.id)
            .count('* as count')
            .first()
        ).count
      ),
      0
    )
  })
})
