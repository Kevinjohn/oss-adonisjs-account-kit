/* eslint-disable @unicorn/no-await-expression-member -- Inline awaited requests keep each assertion tied to the HTTP operation it verifies. */

import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'
import { grantAdmission } from '#tests/helpers/admission'
import { truncateDatabase } from '#tests/helpers/database'
import {
  acceptInvitation,
  as,
  createOwner,
  createPerson,
  type Decision,
  decisionOf,
  domains,
  DOMAINS_ONLY,
  invite,
  refusal,
  signIn,
  socialSignIn,
} from '#tests/helpers/functional_admission'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'

test.group('Admission', (group) => {
  group.each.setup(truncateDatabase)
  group.each.setup(() => notifications.reset())

  test('an invited person is gated until approved, and again after revocation', async ({
    client,
    assert,
  }) => {
    const { owner: ownerUser, credential: owner } = await createOwner(client)
    const email = `invited-${randomUUID()}@example.test`
    assert.equal((await acceptInvitation(client, await invite(client, owner, email))).status(), 201)
    const person = await User.findByOrFail('email', email)
    const session = await signIn(client, email)

    const refused = await as(client.get('/api/v1/reports'), session)
    assert.equal(refused.status(), 403)
    assert.equal(refusal(refused).errors[0].code, 'E_ACCOUNT_KIT_ADMISSION_REQUIRED')
    assert.isFalse(refusal(refused).decision.admitted)
    assert.deepEqual(refusal(refused).decision.requirements.invitation, { met: true })
    assert.deepEqual(refusal(refused).decision.requirements.approval, {
      met: false,
      status: 'pending',
      requested: false,
    })
    // A JSON:API client gets the same refusal in its envelope, with the decision in `meta`.
    const jsonApi = await as(client.get('/api/v1/reports'), session).header(
      'accept',
      'application/vnd.api+json'
    )
    assert.equal(jsonApi.status(), 403)
    assert.match(jsonApi.header('content-type') ?? '', /^application\/vnd\.api\+json/)
    const envelope = jsonApi.body() as {
      errors: Array<{ code: string; title: string }>
      meta: { decision: Decision }
    }
    assert.deepEqual(envelope.errors, [
      { code: 'E_ACCOUNT_KIT_ADMISSION_REQUIRED', title: 'Admission is required' },
    ])
    assert.deepEqual(envelope.meta.decision, refusal(refused).decision)
    assert.notProperty(envelope, 'decision')
    const status = await as(client.get('/api/v1/account/admission'), session)
    assert.equal(status.status(), 200)
    assert.isFalse(decisionOf(status).admitted)

    const requested = await as(client.post('/api/v1/account/admission/request'), session)
    assert.equal(requested.status(), 200, JSON.stringify(requested.body()))
    const pending = await as(client.get('/api/v1/account/admissions'), owner).qs({
      status: 'pending',
    })
    assert.equal(pending.status(), 200, JSON.stringify(pending.body()))
    assert.deepEqual(
      (pending.body() as { items: Array<{ email: string }> }).items.map((item) => item.email),
      [email]
    )

    const invalidIds = ['1'.repeat(65)]
    if (typeof person.id === 'number') {
      invalidIds.push('0', `0${person.id}`, `${person.id}e0`, '9007199254740992')
    }
    for (const id of invalidIds) {
      const malformed = await as(client.post(`/api/v1/account/admissions/${id}/approve`), owner)
      assert.equal(malformed.status(), 422)
      assert.deepEqual(malformed.body(), {
        errors: [{ code: 'E_ACCOUNT_KIT_INVALID_INPUT', message: 'Account request rejected.' }],
      })
    }
    const approved = await as(client.post(`/api/v1/account/admissions/${person.id}/approve`), owner)
    assert.equal(approved.status(), 200, JSON.stringify(approved.body()))
    const approvedBody = approved.body() as { approval: { decidedAt: string } }
    assert.isString(approvedBody.approval.decidedAt)
    assert.deepEqual(approvedBody, {
      userId: person.id,
      approval: {
        status: 'approved',
        actorId: ownerUser.id,
        decidedAt: approvedBody.approval.decidedAt,
      },
    })
    assert.equal((await as(client.get('/api/v1/reports'), session)).status(), 200)

    const revoked = await as(client.post(`/api/v1/account/admissions/${person.id}/revoke`), owner)
    assert.equal(revoked.status(), 200, JSON.stringify(revoked.body()))
    const revokedBody = revoked.body() as { approval: { decidedAt: string } }
    assert.isString(revokedBody.approval.decidedAt)
    assert.deepEqual(revokedBody, {
      userId: person.id,
      approval: {
        status: 'revoked',
        actorId: ownerUser.id,
        decidedAt: revokedBody.approval.decidedAt,
      },
    })
    const afterRevoke = await as(client.get('/api/v1/reports'), session)
    assert.equal(afterRevoke.status(), 403)
    assert.equal(refusal(afterRevoke).decision.requirements.approval?.status, 'revoked')

    const again = await signIn(client, email)
    assert.equal((await as(client.get('/api/v1/reports'), again)).status(), 403)
  })

  test('only an admitted owner lists and decides, and never for themselves', async ({
    client,
    assert,
  }) => {
    const { owner, credential } = await createOwner(client)
    const person = await createPerson()
    const pendingOwner = await createPerson()
    await db.table('role_assignments').insert({ user_id: pendingOwner.id, role: 'owner' })
    const pendingSession = await signIn(client, pendingOwner.email)

    const list = await as(client.get('/api/v1/account/admissions'), pendingSession)
    assert.equal(list.status(), 403)
    assert.equal(refusal(list).errors[0].code, 'E_ACCOUNT_KIT_ADMISSION_REQUIRED')
    const approve = as(
      client.post(`/api/v1/account/admissions/${person.id}/approve`),
      pendingSession
    )
    assert.equal((await approve).status(), 403)
    const self = as(client.post(`/api/v1/account/admissions/${owner.id}/approve`), credential)
    assert.equal((await self).status(), 403)
    const member = await createPerson()
    await grantAdmission(member)
    const memberSession = await signIn(client, member.email)
    assert.equal((await as(client.get('/api/v1/reports'), memberSession)).status(), 200)
    const byMember = as(
      client.post(`/api/v1/account/admissions/${person.id}/approve`),
      memberSession
    )
    assert.equal((await byMember).status(), 403)
    assert.equal((await as(client.get('/api/v1/account/admissions'), memberSession)).status(), 403)
    const row = await db.from('account_admissions').where('user_id', person.id).first()
    assert.isNull(row ?? null)
  })

  test('a rejected person sees the decision and stays out', async ({ client, assert }) => {
    const { credential: owner } = await createOwner(client)
    const person = await createPerson()
    const session = await signIn(client, person.email)
    const rejected = await as(client.post(`/api/v1/account/admissions/${person.id}/reject`), owner)
    assert.equal(rejected.status(), 200, JSON.stringify(rejected.body()))

    const status = await as(client.get('/api/v1/account/admission'), session)
    assert.equal(status.status(), 200)
    assert.equal(decisionOf(status).requirements.approval?.status, 'rejected')
    assert.equal((await as(client.get('/api/v1/reports'), session)).status(), 403)
  })

  test('a revoked owner cannot send an invitation', async ({ client, assert }) => {
    const { credential: owner } = await createOwner(client)
    const { owner: other, credential: otherSession } = await createOwner(client)
    const revoked = await as(client.post(`/api/v1/account/admissions/${other.id}/revoke`), owner)
    assert.equal(revoked.status(), 200, JSON.stringify(revoked.body()))

    const sent = await as(client.post('/api/v1/account/invitations'), otherSession).json({
      email: `refused-${randomUUID()}@example.test`,
      role: 'member',
    })
    assert.equal(sent.status(), 403)
    assert.lengthOf(await db.from('account_invitations'), 0)
  })

  test('an invited address that first signs in through a provider meets the invitation', async ({
    client,
    assert,
  }) => {
    const { credential: owner } = await createOwner(client)
    const email = `social-${randomUUID()}@example.test`
    const link = await invite(client, owner, email)
    const session = await socialSignIn(client, email)

    const status = await as(client.get('/api/v1/account/admission'), session)
    assert.equal(status.status(), 200, JSON.stringify(status.body()))
    assert.deepEqual(decisionOf(status).requirements.invitation, { met: true })
    assert.equal(decisionOf(status).requirements.approval?.status, 'pending')
    const invitations = await as(client.get('/api/v1/account/invitations'), owner).qs({ limit: 10 })
    assert.equal(invitations.status(), 200)
    assert.lengthOf((invitations.body() as { items: unknown[] }).items, 0)
    const accepted = await acceptInvitation(client, link)
    assert.equal(accepted.status(), 400, JSON.stringify(accepted.body()))
    assert.equal(refusal(accepted).errors[0].code, 'E_ACCOUNT_KIT_INVALID_TOKEN')
  })

  test('an approved and invited person outside the allowed domains stays out', async ({
    client,
    assert,
  }) => {
    const inside = await createPerson()
    const outside = await createPerson(`person-${randomUUID()}@outside.test`)
    await grantAdmission(inside)
    await grantAdmission(outside)

    const allowed = await as(client.get('/api/v1/reports'), await signIn(client, inside.email))
    assert.equal(allowed.status(), 200)
    const refused = await as(client.get('/api/v1/reports'), await signIn(client, outside.email))
    assert.equal(refused.status(), 403)
    assert.deepEqual(refusal(refused).decision.requirements.domain, {
      met: false,
      reason: 'not_allowed',
    })
  }).skip(domains !== 'example.test', DOMAINS_ONLY)
})
