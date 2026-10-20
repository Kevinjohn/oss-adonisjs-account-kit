/* eslint-disable @unicorn/no-await-expression-member -- Inline awaited requests keep each assertion tied to the HTTP operation it verifies. */

import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import hash from '@adonisjs/core/services/hash'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'
import { captureFollowUpDiagnostics } from '#tests/helpers/follow_up_diagnostics'
import { tokenFrom } from '#tests/helpers/link_tokens'
import { responseBody } from '#tests/helpers/response_body'
import { truncateDatabase } from '#tests/helpers/database'
import { grantAdmittedOwner } from '#tests/helpers/admission'

test.group('Account invitations', (group) => {
  group.each.setup(truncateDatabase)

  test('invitations over HTTP enforce roles, single acceptance, resend, and revocation', async ({
    client,
    assert,
  }) => {
    notifications.reset()

    const inviter = await User.create({
      fullName: 'Invite Owner',
      email: 'inviter@example.test',
      password: 'InvitePass123!',
      emailVerifiedAt: DateTime.utc(),
    })
    await grantAdmittedOwner(inviter)
    const inviteResponse = await client.post('/api/v1/account/invitations').loginAs(inviter).json({
      email: 'new-member@example.test',
      role: 'editor',
    })
    assert.equal(inviteResponse.status(), 201)
    assert.equal((await client.get('/api/v1/account/invitations')).status(), 401)
    const invitationList = await client
      .get('/api/v1/account/invitations')
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
    assert.equal(
      (await client.get('/api/v1/account/invitations').loginAs(ordinaryUser)).status(),
      403
    )
    assert.equal(
      (
        await client
          .post('/api/v1/account/invitations')
          .loginAs(ordinaryUser)
          .json({ email: 'denied@example.test', role: 'editor' })
      ).status(),
      403
    )
    const invitationToken = tokenFrom(
      notifications.events.find((event) => event.kind === 'invitation')!.value
    )
    const invitationPath = `/api/v1/auth/invitations/${encodeURIComponent(invitationToken)}`
    const invitationInspect = await client.get(invitationPath)
    assert.equal((invitationInspect.body() as { email: string }).email, 'new-member@example.test')
    assert.equal(invitationInspect.header('referrer-policy'), 'no-referrer')
    assert.equal(invitationInspect.header('cache-control'), 'no-store')
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
      400
    )
    assert.equal(
      (
        await client
          .post('/api/v1/account/invitations')
          .loginAs(inviter)
          .json({ email: 'bad', role: '' })
      ).status(),
      422
    )

    const contentionInvite = await client
      .post('/api/v1/account/invitations')
      .loginAs(inviter)
      .json({ email: 'contended-member@example.test', role: 'viewer' })
    assert.equal(contentionInvite.status(), 201)
    const contentionToken = tokenFrom(
      notifications.events.filter((event) => event.kind === 'invitation').at(-1)!.value
    )
    const contentionPath = `/api/v1/auth/invitations/${encodeURIComponent(contentionToken)}`
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
    assert.deepEqual(contentionResponses.map((response) => response.status()).sort(), [201, 400])
    const contendedUsers = await db
      .from(User.table)
      .where('email', 'contended-member@example.test')
      .count('* as count')
      .first()
    assert.equal(Number(contendedUsers?.count), 1)
    process.stdout.write(
      `CONSUMER_CONTENTION_SMOKE ${JSON.stringify({ database: process.env.DB_CONNECTION, elapsedMs: contentionElapsedMs, statuses: contentionResponses.map((response) => response.status()) })}\n`
    )

    const resendSend = await client.post('/api/v1/account/invitations').loginAs(inviter).json({
      email: 'resend@example.test',
      role: 'viewer',
    })
    assert.equal(resendSend.status(), 201)
    const resendId = responseBody<{ id: number }>(resendSend).id
    for (const invalidId of ['abc', '1.5', '9007199254740992']) {
      const invalidResend = await client
        .post(`/api/v1/account/invitations/${invalidId}/resend`)
        .loginAs(inviter)
        .json({})
      const invalidRevoke = await client
        .delete(`/api/v1/account/invitations/${invalidId}`)
        .loginAs(inviter)
        .json({})
      assert.equal(invalidResend.status(), 422)
      assert.equal(
        responseBody<{ errors: [{ code: string }] }>(invalidResend).errors[0].code,
        'E_ACCOUNT_KIT_INVALID_INPUT'
      )
      assert.equal(invalidRevoke.status(), 422)
      assert.equal(
        responseBody<{ errors: [{ code: string }] }>(invalidRevoke).errors[0].code,
        'E_ACCOUNT_KIT_INVALID_INPUT'
      )
    }
    const originalResendToken = tokenFrom(
      notifications.events.filter((event) => event.kind === 'invitation').at(-1)!.value
    )
    const resent = await client
      .post(`/api/v1/account/invitations/${resendId}/resend`)
      .loginAs(inviter)
      .json({})
    assert.equal(resent.status(), 200)
    const resentToken = tokenFrom(
      notifications.events.filter((event) => event.kind === 'invitation').at(-1)!.value
    )
    assert.notEqual(resentToken, originalResendToken)
    assert.equal(
      (
        await client.get(`/api/v1/auth/invitations/${encodeURIComponent(originalResendToken)}`)
      ).status(),
      400
    )
    assert.equal(
      (await client.get(`/api/v1/auth/invitations/${encodeURIComponent(resentToken)}`)).status(),
      200
    )
    assert.equal(
      (
        await client
          .delete(`/api/v1/account/invitations/${resendId}`)
          .loginAs(ordinaryUser)
          .json({})
      ).status(),
      404
    )
    const missingInvitation = await client
      .delete(`/api/v1/account/invitations/${resendId + 999}`)
      .loginAs(inviter)
      .json({})
    const deniedInvitation = await client
      .delete(`/api/v1/account/invitations/${resendId}`)
      .loginAs(ordinaryUser)
      .json({})
    assert.equal(missingInvitation.status(), 404)
    assert.equal(deniedInvitation.status(), 404)
    assert.deepEqual(missingInvitation.body(), deniedInvitation.body())
    notifications.failLifecycle = true
    const revocation = await captureFollowUpDiagnostics(() =>
      client.delete(`/api/v1/account/invitations/${resendId}`).loginAs(inviter).json({})
    )
    const revoked = revocation.result
    notifications.failLifecycle = false
    assert.equal(revoked.status(), 204)
    assert.deepEqual(revocation.entries, [
      {
        event: 'account_kit_follow_up_failed',
        operation: 'invitation.revoke',
        failure: 'post_commit',
      },
    ])
    assert.equal(
      (await client.get(`/api/v1/auth/invitations/${encodeURIComponent(resentToken)}`)).status(),
      400
    )
  })
})
