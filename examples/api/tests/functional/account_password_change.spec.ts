/* eslint-disable @unicorn/no-await-expression-member -- Inline awaited requests keep each assertion tied to the HTTP operation it verifies. */

import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import hash from '@adonisjs/core/services/hash'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'
import { dispatchAccountKitOutbox } from '#services/account_kit_outbox'
import { resetAccountState } from '#tests/helpers/account_state'
import { captureFollowUpDiagnostics } from '#tests/helpers/follow_up_diagnostics'
import { responseBody } from '#tests/helpers/response_body'

test('password change over HTTP requires proof, revokes tokens, and reports follow-up failures', async ({
  client,
  assert,
}) => {
  await resetAccountState()

  const passwordUser = await User.create({
    fullName: 'Password User',
    email: 'password@example.test',
    password: 'CurrentPass123!',
    emailVerifiedAt: DateTime.utc(),
  })
  await User.accessTokens.create(passwordUser)
  assert.equal(
    Number(
      (
        await db
          .from('auth_access_tokens')
          .where('tokenable_id', passwordUser.id)
          .count('* as count')
          .first()
      ).count
    ),
    1
  )
  assert.equal(
    (
      await client.post('/api/v1/account/password').loginAs(passwordUser).json({
        currentPassword: 'CurrentPass123!',
        newPassword: 'ChangedPass123!',
        newPasswordConfirmation: 'MismatchPass123!',
      })
    ).status(),
    422
  )
  const changePassword = await client.post('/api/v1/account/password').loginAs(passwordUser).json({
    currentPassword: 'CurrentPass123!',
    newPassword: 'ChangedPass123!',
    newPasswordConfirmation: 'ChangedPass123!',
  })
  assert.equal(changePassword.status(), 200)
  await passwordUser.refresh()
  assert.isTrue(await hash.verify(passwordUser.password!, 'ChangedPass123!'))
  const passwordChangeNotice = notifications.events.find(
    (event) => event.kind === 'passwordChanged'
  )!
  const passwordChangeOutbox = await db
    .from('account_kit_outbox')
    .where('user_id', passwordUser.id)
    .where('operation', 'password_change')
    .first()
  assert.isNotNull(passwordChangeOutbox)
  assert.equal(passwordChangeOutbox.operation_id, passwordChangeNotice.value)
  assert.equal(passwordChangeNotice.recipient, passwordUser.email)
  assert.equal(await dispatchAccountKitOutbox(), 1)
  assert.equal(
    Number(
      (
        await db
          .from('auth_access_tokens')
          .where('tokenable_id', passwordUser.id)
          .count('* as count')
          .first()
      ).count
    ),
    0
  )
  const badProof = await client.post('/api/v1/account/password').loginAs(passwordUser).json({
    currentPassword: 'wrong-proof',
    newPassword: 'ChangedAgain123!',
    newPasswordConfirmation: 'ChangedAgain123!',
  })
  assert.equal(badProof.status(), 403)
  assert.equal(
    responseBody<{ errors: [{ code: string }] }>(badProof).errors[0].code,
    'E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED'
  )
  notifications.failPasswordChanged = true
  const passwordFollowUp = await captureFollowUpDiagnostics(() =>
    client.post('/api/v1/account/password').loginAs(passwordUser).json({
      currentPassword: 'ChangedPass123!',
      newPassword: 'FinalPass123!',
      newPasswordConfirmation: 'FinalPass123!',
    })
  )
  const committedPasswordChange = passwordFollowUp.result
  notifications.failPasswordChanged = false
  assert.equal(committedPasswordChange.status(), 200)
  assert.deepEqual(passwordFollowUp.entries, [
    {
      event: 'account_kit_follow_up_failed',
      operation: 'account_password.change',
      failure: 'post_commit',
    },
  ])
  await passwordUser.refresh()
  assert.isTrue(await hash.verify(passwordUser.password!, 'FinalPass123!'))
})
