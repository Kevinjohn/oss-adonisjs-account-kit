/* eslint-disable @unicorn/no-await-expression-member -- Inline awaited requests keep each assertion tied to the HTTP operation it verifies. */

import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'
import { captureFollowUpDiagnostics } from '#tests/helpers/follow_up_diagnostics'
import { tokenFrom } from '#tests/helpers/link_tokens'
import { responseBody } from '#tests/helpers/response_body'

test('committed account follow-ups report safe operation-specific diagnostics', async ({
  client,
  assert,
}) => {
  const suffix = randomUUID()
  notifications.reset()
  const expectFailure = (entries: unknown[], operation: string, failure: string) =>
    assert.deepEqual(entries, [{ event: 'account_kit_follow_up_failed', operation, failure }])
  try {
    const unverified = await User.create({
      fullName: 'Verification Diagnostic',
      email: `verification-${suffix}@example.test`,
      unverifiedEmail: `verification-${suffix}@example.test`,
      password: 'VerificationPass123!',
    })
    notifications.failVerification = true
    const verificationSend = await captureFollowUpDiagnostics(() =>
      client.post('/api/v1/account/email-verification/send').loginAs(unverified).json({})
    )
    notifications.failVerification = false
    assert.equal(verificationSend.result.status(), 200)
    assert.deepEqual(verificationSend.result.body(), { result: 'sent' })
    expectFailure(verificationSend.entries, 'email_verification.send', 'delivery')

    const claimUser = await User.create({
      fullName: 'Claim Diagnostic',
      email: `claim-${suffix}@example.test`,
      unverifiedEmail: `claim-${suffix}@example.test`,
      password: 'ClaimPass123!',
    })
    assert.equal(
      (
        await client.post('/api/v1/account/email-verification/send').loginAs(claimUser).json({})
      ).status(),
      200
    )
    const claimToken = tokenFrom(
      notifications.events.filter((event) => event.kind === 'verification').at(-1)!.value
    )
    notifications.failLifecycle = true
    const verificationComplete = await captureFollowUpDiagnostics(() =>
      client.post(`/api/v1/auth/email-verification/${encodeURIComponent(claimToken)}`).json({
        password: 'ClaimedPass123!',
        passwordConfirmation: 'ClaimedPass123!',
      })
    )
    notifications.failLifecycle = false
    assert.equal(verificationComplete.result.status(), 200)
    assert.deepEqual(verificationComplete.result.body(), { result: 'verified' })
    expectFailure(verificationComplete.entries, 'email_verification.complete', 'post_commit')

    const inviter = await User.create({
      fullName: 'Invitation Diagnostic',
      email: `inviter-${suffix}@example.test`,
      password: 'InviterPass123!',
      emailVerifiedAt: DateTime.utc(),
    })
    await db.table('role_assignments').insert({ user_id: inviter.id, role: 'owner' })
    const invitedEmail = `invite-${suffix}@example.test`
    notifications.failLifecycle = true
    const invitationSend = await captureFollowUpDiagnostics(() =>
      client
        .post('/api/v1/account/invitations')
        .loginAs(inviter)
        .json({ email: invitedEmail, role: 'viewer' })
    )
    notifications.failLifecycle = false
    assert.equal(invitationSend.result.status(), 202)
    assert.deepEqual(invitationSend.result.body(), { requested: true })
    expectFailure(invitationSend.entries, 'invitation.send', 'post_commit')
    const inviteToken = tokenFrom(
      notifications.events.filter((event) => event.kind === 'invitation').at(-1)!.value
    )
    notifications.failLifecycle = true
    const invitationAccept = await captureFollowUpDiagnostics(() =>
      client.post(`/api/v1/auth/invitations/${encodeURIComponent(inviteToken)}`).json({
        fullName: 'Invited Diagnostic',
        password: 'InvitedPass123!',
        passwordConfirmation: 'InvitedPass123!',
      })
    )
    notifications.failLifecycle = false
    assert.equal(invitationAccept.result.status(), 202)
    assert.deepEqual(invitationAccept.result.body(), { accepted: true })
    expectFailure(invitationAccept.entries, 'invitation.accept', 'post_commit')
    assert.isNotNull(await User.findBy('email', invitedEmail))

    const resendEmail = `resend-${suffix}@example.test`
    const resendSend = await client
      .post('/api/v1/account/invitations')
      .loginAs(inviter)
      .json({ email: resendEmail, role: 'viewer' })
    assert.equal(resendSend.status(), 201)
    const resendId = responseBody<{ id: number }>(resendSend).id
    notifications.failLifecycle = true
    const invitationResend = await captureFollowUpDiagnostics(() =>
      client.post(`/api/v1/account/invitations/${resendId}/resend`).loginAs(inviter).json({})
    )
    notifications.failLifecycle = false
    assert.equal(invitationResend.result.status(), 202)
    assert.deepEqual(invitationResend.result.body(), { requested: true })
    expectFailure(invitationResend.entries, 'invitation.resend', 'post_commit')

    const profileUser = await User.create({
      fullName: 'Profile Diagnostic',
      email: `profile-${suffix}@example.test`,
      password: 'ProfilePass123!',
      emailVerifiedAt: DateTime.utc(),
    })
    notifications.failLifecycle = true
    const profileUpdate = await captureFollowUpDiagnostics(() =>
      client
        .patch('/api/v1/account/profile')
        .loginAs(profileUser)
        .json({
          currentPassword: 'ProfilePass123!',
          email: `changed-${suffix}@example.test`,
        })
    )
    notifications.failLifecycle = false
    assert.equal(profileUpdate.result.status(), 200)
    assert.deepEqual(profileUpdate.result.body(), { updated: true })
    expectFailure(profileUpdate.entries, 'profile.update', 'post_commit')
    const emailToken = tokenFrom(
      notifications.events.filter((event) => event.kind === 'emailChangeConfirm').at(-1)!.value
    )
    notifications.failLifecycle = true
    const emailComplete = await captureFollowUpDiagnostics(() =>
      client.post(`/api/v1/auth/email-change/${encodeURIComponent(emailToken)}`).json({})
    )
    notifications.failLifecycle = false
    assert.equal(emailComplete.result.status(), 200)
    assert.deepEqual(emailComplete.result.body(), { changed: true })
    expectFailure(emailComplete.entries, 'email_change.complete', 'post_commit')
    await profileUser.refresh()
    assert.equal(profileUser.email, `changed-${suffix}@example.test`)
  } finally {
    notifications.reset()
  }
})
