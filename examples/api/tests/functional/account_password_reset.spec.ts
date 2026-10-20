/* eslint-disable @unicorn/no-await-expression-member -- Inline awaited requests keep each assertion tied to the HTTP operation it verifies. */

import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import hash from '@adonisjs/core/services/hash'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'
import { dispatchAccountKitOutbox } from '#services/account_kit_outbox'
import { resetAccountState } from '#tests/helpers/account_state'
import { captureFollowUpDiagnostics } from '#tests/helpers/follow_up_diagnostics'
import { tokenFrom } from '#tests/helpers/link_tokens'

test('password reset over HTTP hides unknown accounts, consumes tokens once, and retries the outbox', async ({
  client,
  assert,
}) => {
  await resetAccountState()

  const recoveryUser = await User.create({
    fullName: 'Recovery User',
    email: 'recovery@example.test',
    password: 'StartPass123!',
  })
  const known = await client
    .post('/api/v1/auth/password-reset')
    .json({ email: 'recovery@example.test' })
  const unknown = await client
    .post('/api/v1/auth/password-reset')
    .json({ email: 'missing@example.test' })
  assert.equal(known.status(), 202)
  assert.equal(unknown.status(), 202)
  assert.deepEqual(known.body(), unknown.body())
  assert.equal(notifications.events.filter((event) => event.kind === 'recovery').length, 1)

  notifications.failRecovery = true
  const delivery = await captureFollowUpDiagnostics(() =>
    client.post('/api/v1/auth/password-reset').json({ email: 'recovery@example.test' })
  )
  const failedDelivery = delivery.result
  notifications.failRecovery = false
  assert.equal(failedDelivery.status(), 202)
  assert.deepEqual(failedDelivery.body(), known.body())
  assert.deepEqual(delivery.entries, [
    {
      event: 'account_kit_follow_up_failed',
      operation: 'password_reset.request',
      failure: 'delivery',
    },
  ])
  notifications.failLifecycle = true
  const observer = await captureFollowUpDiagnostics(() =>
    client.post('/api/v1/auth/password-reset').json({ email: 'recovery@example.test' })
  )
  const failedObserver = observer.result
  notifications.failLifecycle = false
  assert.equal(failedObserver.status(), 202)
  assert.deepEqual(failedObserver.body(), known.body())
  assert.deepEqual(observer.entries, [
    {
      event: 'account_kit_follow_up_failed',
      operation: 'password_reset.request',
      failure: 'post_commit',
    },
  ])
  const finalRecoveryRequest = await client
    .post('/api/v1/auth/password-reset')
    .json({ email: 'recovery@example.test' })
  assert.equal(finalRecoveryRequest.status(), 202)
  const recoveryToken = tokenFrom(
    notifications.events.filter((event) => event.kind === 'recovery').at(-1)!.value
  )
  const recoveryPath = `/api/v1/auth/password-reset/${encodeURIComponent(recoveryToken)}`
  await User.accessTokens.create(recoveryUser)
  assert.equal(
    Number(
      (
        await db
          .from('auth_access_tokens')
          .where('tokenable_id', recoveryUser.id)
          .count('* as count')
          .first()
      ).count
    ),
    1
  )
  const inspectOne = await client.get(recoveryPath)
  const inspectTwo = await client.get(recoveryPath)
  assert.equal(inspectOne.status(), 200)
  assert.equal(inspectOne.header('referrer-policy'), 'no-referrer')
  assert.equal(inspectOne.header('cache-control'), 'no-store')
  assert.deepEqual(inspectOne.body(), inspectTwo.body())
  assert.equal(
    (
      await client.post(recoveryPath).json({
        password: 'RecoveredPass123!',
        passwordConfirmation: 'MismatchPass123!',
      })
    ).status(),
    422
  )
  const reset = await client.post(recoveryPath).json({
    password: 'RecoveredPass123!',
    passwordConfirmation: 'RecoveredPass123!',
  })
  assert.equal(reset.status(), 202)
  await recoveryUser.refresh()
  assert.isTrue(await hash.verify(recoveryUser.password!, 'RecoveredPass123!'))
  assert.isNull(recoveryUser.unverifiedEmail)
  assert.equal(
    Number(
      (
        await db
          .from('auth_access_tokens')
          .where('tokenable_id', recoveryUser.id)
          .count('* as count')
          .first()
      ).count
    ),
    0
  )
  const resetNotice = notifications.events.find((event) => event.kind === 'passwordReset')!
  const resetOutbox = await db
    .from('account_kit_outbox')
    .where('user_id', recoveryUser.id)
    .where('operation', 'password_reset')
    .first()
  assert.isNotNull(resetOutbox)
  assert.equal(resetOutbox.operation_id, resetNotice.value)
  assert.equal(resetNotice.recipient, recoveryUser.email)
  assert.isNull(resetOutbox.sent_at)
  assert.equal(await dispatchAccountKitOutbox(), 1)
  const dispatchedResetOutbox = await db
    .from('account_kit_outbox')
    .where('id', resetOutbox.id)
    .first()
  assert.isNotNull(dispatchedResetOutbox.sent_at)
  assert.equal(
    notifications.events.filter((event) => event.value === resetOutbox.operation_id).length,
    1
  )
  assert.equal(await dispatchAccountKitOutbox(), 0)
  assert.equal(
    notifications.lifecycleEvents.some(
      (event) => event.type === 'password.reset' && event.userId === recoveryUser.id
    ),
    true
  )
  assert.equal(
    (
      await client.post(recoveryPath).json({
        password: 'AnotherPass123!',
        passwordConfirmation: 'AnotherPass123!',
      })
    ).status(),
    400
  )
  assert.equal(
    (await client.post('/api/v1/auth/password-reset').json({ email: 'bad' })).status(),
    422
  )
  const postCommitRequest = await client
    .post('/api/v1/auth/password-reset')
    .json({ email: recoveryUser.email })
  const postCommitToken = tokenFrom(
    notifications.events.filter((event) => event.kind === 'recovery').at(-1)!.value
  )
  notifications.failPasswordReset = true
  const postCommit = await captureFollowUpDiagnostics(() =>
    client
      .post(`/api/v1/auth/password-reset/${encodeURIComponent(postCommitToken)}`)
      .json({ password: 'CommittedReset123!', passwordConfirmation: 'CommittedReset123!' })
  )
  const postCommitResponse = postCommit.result
  notifications.failPasswordReset = false
  assert.equal(postCommitRequest.status(), 202)
  assert.equal(postCommitResponse.status(), 202)
  assert.deepEqual(postCommitResponse.body(), { message: 'Password reset.' })
  assert.deepEqual(postCommit.entries, [
    {
      event: 'account_kit_follow_up_failed',
      operation: 'password_reset.complete',
      failure: 'post_commit',
    },
  ])
  const pendingOutbox = await db
    .from('account_kit_outbox')
    .where('operation', 'password_reset')
    .where('recipient_email', recoveryUser.email)
    .orderBy('id', 'desc')
    .first()
  assert.isNotNull(pendingOutbox)
  assert.isNull(pendingOutbox.sent_at)
  assert.equal(pendingOutbox.attempts, 0)
  notifications.crashAfterOutboxSend = true
  let workerInterrupted = false
  try {
    await dispatchAccountKitOutbox()
  } catch {
    workerInterrupted = true
  }
  assert.isTrue(workerInterrupted)
  const retryableOutbox = await db.from('account_kit_outbox').where('id', pendingOutbox.id).first()
  assert.isNull(retryableOutbox.sent_at)
  assert.equal(retryableOutbox.attempts, 1)
  assert.equal(retryableOutbox.last_error, 'delivery_failed')
  assert.equal(
    notifications.events.filter((event) => event.value === pendingOutbox.operation_id).length,
    1
  )
  assert.equal(await dispatchAccountKitOutbox(), 1)
  assert.equal(await dispatchAccountKitOutbox(), 0)
  const deliveredRetry = await db.from('account_kit_outbox').where('id', pendingOutbox.id).first()
  assert.isNotNull(deliveredRetry.sent_at)
  assert.equal(deliveredRetry.attempts, 1)
  assert.equal(
    notifications.events.filter((event) => event.value === pendingOutbox.operation_id).length,
    1
  )
})
