/* eslint-disable @unicorn/no-await-expression-member -- Inline awaited requests keep each assertion tied to the HTTP operation it verifies. */

import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import hash from '@adonisjs/core/services/hash'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'
import { dispatchAccountKitOutbox } from '#services/account_kit_outbox'

const tokenFrom = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').at(-1)!)
const responseBody = <T>(response: { body(): unknown }) => response.body() as T

test('account workflows over HTTP commit, notify, and enforce token boundaries', async ({
  client,
  assert,
}) => {
  notifications.reset()
  await db.from('role_assignments').delete()
  await db.from('password_reset_tokens').delete()
  await db.from('account_invitations').delete()
  await db.from('email_verification_tokens').delete()
  await db.from('auth_access_tokens').delete()
  await User.query().delete()

  const missingProfile = await client.post('/api/v1/auth/signup').json({
    email: 'missing-profile@example.test',
    password: 'MissingPass123!',
    passwordConfirmation: 'MissingPass123!',
  } as never)
  assert.equal(missingProfile.status(), 422)
  const registration = await client.post('/api/v1/auth/signup').json({
    fullName: 'Registration User',
    email: ' Registration@Example.Test ',
    password: 'RegistrationPass123!',
    passwordConfirmation: 'RegistrationPass123!',
  })
  assert.equal(registration.status(), 200)
  const registrationBody = responseBody<{
    data: { user: { fullName: string; email: string }; token: string }
  }>(registration)
  assert.equal(registrationBody.data.user.fullName, 'Registration User')
  assert.equal(registrationBody.data.user.email, 'registration@example.test')
  const registered = await User.findByOrFail('email', 'registration@example.test')
  assert.equal(registered.unverifiedEmail, registered.email)
  assert.isNull(registered.emailVerifiedAt)
  const registrationActivation = await client
    .post('/account-kit/verification/send')
    .loginAs(registered)
    .json({})
  assert.equal(registrationActivation.status(), 200)
  assert.equal(registrationActivation.body().result, 'sent')
  const registrationToken = tokenFrom(
    notifications.events.find((event) => event.kind === 'verification')!.value
  )
  const activation = await client.get(
    `/account-kit/verification/${encodeURIComponent(registrationToken)}`
  )
  assert.equal(activation.body().result, 'verified')
  assert.isNull((await User.findByOrFail('email', registered.email)).unverifiedEmail)
  notifications.reset()
  assert.isString(registrationBody.data.token)
  assert.notProperty(registrationBody.data.user, 'password')
  assert.equal(
    (
      await client.post('/api/v1/auth/signup').json({
        fullName: 'Duplicate User',
        email: 'REGISTRATION@EXAMPLE.TEST',
        password: 'DuplicatePass123!',
        passwordConfirmation: 'DuplicatePass123!',
      })
    ).status(),
    422
  )
  const normalizedLogin = await client.post('/api/v1/auth/login').json({
    email: ' REGISTRATION@EXAMPLE.TEST ',
    password: 'RegistrationPass123!',
  })
  assert.equal(normalizedLogin.status(), 200)

  const recoveryUser = await User.create({
    fullName: 'Recovery User',
    email: 'recovery@example.test',
    password: 'StartPass123!',
  })
  const known = await client.post('/account-kit/recovery').json({ email: 'recovery@example.test' })
  const unknown = await client.post('/account-kit/recovery').json({ email: 'missing@example.test' })
  assert.equal(known.status(), 202)
  assert.equal(unknown.status(), 202)
  assert.deepEqual(known.body(), unknown.body())
  assert.equal(notifications.events.filter((event) => event.kind === 'recovery').length, 1)

  notifications.failRecovery = true
  const failedDelivery = await client
    .post('/account-kit/recovery')
    .json({ email: 'recovery@example.test' })
  notifications.failRecovery = false
  assert.equal(failedDelivery.status(), 202)
  assert.deepEqual(failedDelivery.body(), known.body())
  notifications.failLifecycle = true
  const failedObserver = await client
    .post('/account-kit/recovery')
    .json({ email: 'recovery@example.test' })
  notifications.failLifecycle = false
  assert.equal(failedObserver.status(), 202)
  assert.deepEqual(failedObserver.body(), known.body())
  const finalRecoveryRequest = await client
    .post('/account-kit/recovery')
    .json({ email: 'recovery@example.test' })
  assert.equal(finalRecoveryRequest.status(), 202)
  const recoveryToken = tokenFrom(
    notifications.events.filter((event) => event.kind === 'recovery').at(-1)!.value
  )
  const recoveryPath = `/account-kit/recovery/${encodeURIComponent(recoveryToken)}`
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
    422
  )
  assert.equal((await client.post('/account-kit/recovery').json({ email: 'bad' })).status(), 422)
  const postCommitRequest = await client
    .post('/account-kit/recovery')
    .json({ email: recoveryUser.email })
  const postCommitToken = tokenFrom(
    notifications.events.filter((event) => event.kind === 'recovery').at(-1)!.value
  )
  notifications.failPasswordReset = true
  const postCommitResponse = await client
    .post(`/account-kit/recovery/${encodeURIComponent(postCommitToken)}`)
    .json({ password: 'CommittedReset123!', passwordConfirmation: 'CommittedReset123!' })
  notifications.failPasswordReset = false
  assert.equal(postCommitRequest.status(), 202)
  assert.equal(postCommitResponse.status(), 500)
  const postCommitBody = responseBody<{ code: string; committed: boolean; cause?: unknown }>(
    postCommitResponse
  )
  assert.equal(postCommitBody.code, 'E_ACCOUNT_KIT_POST_COMMIT')
  assert.equal(postCommitBody.committed, true)
  assert.notProperty(postCommitBody, 'cause')
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

  const verificationUser = await User.create({
    fullName: 'Verify User',
    email: 'verify@example.test',
    unverifiedEmail: 'verify@example.test',
    password: 'VerifyPass123!',
  })
  const anonymousVerify = await client.post('/account-kit/verification/send').json({})
  assert.equal(anonymousVerify.status(), 401)
  const sendVerification = await client
    .post('/account-kit/verification/send')
    .loginAs(verificationUser)
    .json({})
  assert.equal(sendVerification.status(), 200)
  assert.equal(sendVerification.body().result, 'sent')
  const verificationToken = tokenFrom(
    notifications.events.find((event) => event.kind === 'verification')!.value
  )
  const verificationPath = `/account-kit/verification/${encodeURIComponent(verificationToken)}`
  const verificationFirst = await client.get(verificationPath)
  assert.equal(verificationFirst.header('referrer-policy'), 'no-referrer')
  assert.equal((verificationFirst.body() as { result: string }).result, 'verified')
  assert.equal((await client.get(verificationPath)).status(), 422)
  assert.equal(
    (
      (
        await client.post('/account-kit/verification/send').loginAs(verificationUser).json({})
      ).body() as { result: string }
    ).result,
    'already_verified'
  )

  const inviter = await User.create({
    fullName: 'Invite Owner',
    email: 'inviter@example.test',
    password: 'InvitePass123!',
    emailVerifiedAt: DateTime.utc(),
  })
  await db.table('role_assignments').insert({ user_id: inviter.id, role: 'owner' })
  const inviteResponse = await client.post('/account-kit/invitations').loginAs(inviter).json({
    email: 'new-member@example.test',
    role: 'editor',
  })
  assert.equal(inviteResponse.status(), 201)
  assert.equal((await client.get('/account-kit/invitations')).status(), 401)
  const invitationList = await client
    .get('/account-kit/invitations')
    .loginAs(inviter)
    .qs({ limit: 10 })
  assert.equal(invitationList.status(), 200)
  assert.equal(
    responseBody<{ items: Array<{ email: string }> }>(invitationList).items[0].email,
    'new-member@example.test'
  )
  const ordinaryUser = await User.create({
    fullName: 'Ordinary User',
    email: 'ordinary@example.test',
    password: 'OrdinaryPass123!',
  })
  assert.equal((await client.get('/account-kit/invitations').loginAs(ordinaryUser)).status(), 403)
  assert.equal(
    (
      await client
        .post('/account-kit/invitations')
        .loginAs(ordinaryUser)
        .json({ email: 'denied@example.test', role: 'editor' })
    ).status(),
    403
  )
  const invitationToken = tokenFrom(
    notifications.events.find((event) => event.kind === 'invitation')!.value
  )
  const invitationPath = `/account-kit/invitation/${encodeURIComponent(invitationToken)}`
  const invitationInspect = await client.get(invitationPath)
  assert.equal((invitationInspect.body() as { email: string }).email, 'new-member@example.test')
  assert.equal(invitationInspect.header('referrer-policy'), 'no-referrer')
  assert.deepEqual((await client.get(invitationPath)).body(), invitationInspect.body())
  assert.equal(
    (
      await client.post(invitationPath).json({
        password: 'MemberPass123!',
        passwordConfirmation: 'MismatchPass123!',
        fullName: 'New Member',
      })
    ).status(),
    422
  )
  assert.equal(
    (
      await client.post(invitationPath).json({
        password: 'MemberPass123!',
        passwordConfirmation: 'MemberPass123!',
        fullName: '   ',
      })
    ).status(),
    422
  )
  const accepted = await client.post(invitationPath).json({
    password: 'MemberPass123!',
    passwordConfirmation: 'MemberPass123!',
    fullName: 'New Member',
  })
  assert.equal(accepted.status(), 201)
  assert.equal(accepted.header('referrer-policy'), 'no-referrer')
  assert.equal((accepted.body() as { verified: boolean }).verified, true)
  const invited = await User.findByOrFail('email', 'new-member@example.test')
  assert.equal(invited.fullName, 'New Member')
  assert.isTrue(await hash.verify(invited.password!, 'MemberPass123!'))
  const role = await db.from('role_assignments').where('user_id', invited.id).first()
  assert.equal(role.role, 'editor')
  assert.equal(
    (
      await client.post(invitationPath).json({
        password: 'OtherPass123!',
        passwordConfirmation: 'OtherPass123!',
        fullName: 'Other Member',
      })
    ).status(),
    422
  )
  assert.equal(
    (
      await client
        .post('/account-kit/invitations')
        .loginAs(inviter)
        .json({ email: 'bad', role: '' })
    ).status(),
    422
  )

  const contentionInvite = await client
    .post('/account-kit/invitations')
    .loginAs(inviter)
    .json({ email: 'contended-member@example.test', role: 'viewer' })
  assert.equal(contentionInvite.status(), 201)
  const contentionToken = tokenFrom(
    notifications.events.filter((event) => event.kind === 'invitation').at(-1)!.value
  )
  const contentionPath = `/account-kit/invitation/${encodeURIComponent(contentionToken)}`
  const contentionStartedAt = performance.now()
  const contentionResponses = await Promise.all([
    client.post(contentionPath).json({
      password: 'ContentionPass123!',
      passwordConfirmation: 'ContentionPass123!',
      fullName: 'Contended Member',
    }),
    client.post(contentionPath).json({
      password: 'ContentionPass123!',
      passwordConfirmation: 'ContentionPass123!',
      fullName: 'Contended Member',
    }),
  ])
  const contentionElapsedMs = Math.round(performance.now() - contentionStartedAt)
  assert.deepEqual(contentionResponses.map((response) => response.status()).sort(), [201, 422])
  const contendedUsers = await db
    .from(User.table)
    .where('email', 'contended-member@example.test')
    .count('* as count')
    .first()
  assert.equal(Number(contendedUsers?.count), 1)
  process.stdout.write(
    `CONSUMER_CONTENTION_SMOKE ${JSON.stringify({ database: process.env.DB_CONNECTION, elapsedMs: contentionElapsedMs, statuses: contentionResponses.map((response) => response.status()) })}\n`
  )

  const resendSend = await client.post('/account-kit/invitations').loginAs(inviter).json({
    email: 'resend@example.test',
    role: 'viewer',
  })
  assert.equal(resendSend.status(), 201)
  const resendId = responseBody<{ id: number }>(resendSend).id
  for (const invalidId of ['abc', '1.5', '9007199254740992']) {
    const invalidResend = await client
      .post(`/account-kit/invitations/${invalidId}/resend`)
      .loginAs(inviter)
      .json({})
    const invalidRevoke = await client
      .delete(`/account-kit/invitations/${invalidId}`)
      .loginAs(inviter)
      .json({})
    assert.equal(invalidResend.status(), 422)
    assert.equal(responseBody<{ code: string }>(invalidResend).code, 'E_ACCOUNT_KIT_INVALID_INPUT')
    assert.equal(invalidRevoke.status(), 422)
    assert.equal(responseBody<{ code: string }>(invalidRevoke).code, 'E_ACCOUNT_KIT_INVALID_INPUT')
  }
  const originalResendToken = tokenFrom(
    notifications.events.filter((event) => event.kind === 'invitation').at(-1)!.value
  )
  const resent = await client
    .post(`/account-kit/invitations/${resendId}/resend`)
    .loginAs(inviter)
    .json({})
  assert.equal(resent.status(), 200)
  const resentToken = tokenFrom(
    notifications.events.filter((event) => event.kind === 'invitation').at(-1)!.value
  )
  assert.notEqual(resentToken, originalResendToken)
  assert.equal(
    (
      await client.get(`/account-kit/invitation/${encodeURIComponent(originalResendToken)}`)
    ).status(),
    422
  )
  assert.equal(
    (await client.get(`/account-kit/invitation/${encodeURIComponent(resentToken)}`)).status(),
    200
  )
  assert.equal(
    (
      await client.delete(`/account-kit/invitations/${resendId}`).loginAs(ordinaryUser).json({})
    ).status(),
    404
  )
  const missingInvitation = await client
    .delete(`/account-kit/invitations/${resendId + 999}`)
    .loginAs(inviter)
    .json({})
  const deniedInvitation = await client
    .delete(`/account-kit/invitations/${resendId}`)
    .loginAs(ordinaryUser)
    .json({})
  assert.equal(missingInvitation.status(), 404)
  assert.equal(deniedInvitation.status(), 404)
  assert.deepEqual(missingInvitation.body(), deniedInvitation.body())
  const revoked = await client
    .delete(`/account-kit/invitations/${resendId}`)
    .loginAs(inviter)
    .json({})
  assert.equal(revoked.status(), 204)
  assert.equal(
    (await client.get(`/account-kit/invitation/${encodeURIComponent(resentToken)}`)).status(),
    422
  )

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
      await client.post('/account-kit/credentials/password').loginAs(passwordUser).json({
        currentPassword: 'CurrentPass123!',
        newPassword: 'ChangedPass123!',
        newPasswordConfirmation: 'MismatchPass123!',
      })
    ).status(),
    422
  )
  const changePassword = await client
    .post('/account-kit/credentials/password')
    .loginAs(passwordUser)
    .json({
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
  const badProof = await client
    .post('/account-kit/credentials/password')
    .loginAs(passwordUser)
    .json({
      currentPassword: 'wrong-proof',
      newPassword: 'ChangedAgain123!',
      newPasswordConfirmation: 'ChangedAgain123!',
    })
  assert.equal(badProof.status(), 403)
  assert.equal(
    responseBody<{ code: string }>(badProof).code,
    'E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED'
  )

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
  const emailRequest = await client.post('/account-kit/credentials/email').loginAs(emailUser).json({
    currentPassword: 'EmailPass123!',
    newEmail: 'New-Address@example.test',
  })
  assert.equal(emailRequest.status(), 202)
  const emailNotice = notifications.events.find((event) => event.kind === 'emailChangeConfirm')!
  assert.equal(emailNotice.recipient, 'new-address@example.test')
  const emailToken = tokenFrom(emailNotice.value)
  const emailPath = `/account-kit/email-change/${encodeURIComponent(emailToken)}`
  assert.equal((await client.get(emailPath)).header('referrer-policy'), 'no-referrer')
  await emailUser.refresh()
  assert.equal(emailUser.email, 'old-address@example.test')
  const emailComplete = await client.post(emailPath).json({})
  assert.equal(emailComplete.status(), 200)
  assert.equal((emailComplete.body() as { email: string }).email, 'new-address@example.test')
  assert.equal((emailComplete.body() as { verified: boolean }).verified, true)
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
  assert.equal(await dispatchAccountKitOutbox(), 0)
  assert.equal((await client.post(emailPath).json({})).status(), 422)
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
