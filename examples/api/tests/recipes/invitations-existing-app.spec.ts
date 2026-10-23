/* eslint-disable @unicorn/filename-case -- P6 names acceptance specs after the recipe slug. */
/* eslint-disable @unicorn/no-await-expression-member -- Keep each assertion next to its request. */

import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'

type RecipeDelivery = { sentInvitations: string[] }

type Snapshot = { accounts: unknown[]; access: unknown[] }

async function truncateRecipeDatabase() {
  const truncate = await testUtils.db().truncate()
  await truncate()
  await db.table('account_transaction_lock').insert({ id: 1, version: 0 })
}

async function snapshot(): Promise<Snapshot> {
  return {
    accounts: await db.from('users').orderBy('id'),
    access: await db.from('app_user_roles').orderBy('id'),
  }
}

async function tokenFor(user: User, abilities: string[] = ['*']): Promise<string> {
  const token = await User.accessTokens.create(user, abilities, { expiresIn: '1d' })
  return token.value!.release()
}

test.group('existing app invitations', (group) => {
  group.setup(truncateRecipeDatabase)
  group.teardown(truncateRecipeDatabase)

  test('enforces owner policy and one-time acceptance', async ({ client, assert }) => {
    // This service is supplied by the recipe patch, not the reference app.
    const deliveryModule = '#services/invitation_delivery'
    const { sentInvitations } = (await import(deliveryModule)) as RecipeDelivery
    sentInvitations.length = 0
    const owner = await User.create({
      fullName: 'Application Owner',
      email: 'owner@example.test',
      password: 'OwnerPass123!',
    })
    await db.table('app_user_roles').insert({ user_id: owner.id, role: 'owner' })
    const ownerToken = await tokenFor(owner)
    const restrictedToken = await tokenFor(owner, ['profile:read'])
    const member = await User.create({
      fullName: 'Application Member',
      email: 'member@example.test',
      password: 'MemberPass123!',
    })
    const memberToken = await tokenFor(member)

    const beforeGuest = await snapshot()
    assert.equal(
      (
        await client
          .post('/api/v1/account/invitations')
          .json({ email: 'guest@example.test', role: 'member' })
      ).status(),
      401
    )
    assert.deepEqual(await snapshot(), beforeGuest)

    const beforeAbility = await snapshot()
    assert.equal(
      (
        await client
          .post('/api/v1/account/invitations')
          .bearerToken(restrictedToken)
          .json({ email: 'restricted@example.test', role: 'member' })
      ).status(),
      403
    )
    assert.deepEqual(await snapshot(), beforeAbility)

    const beforeRole = await snapshot()
    assert.equal(
      (
        await client
          .post('/api/v1/account/invitations')
          .bearerToken(memberToken)
          .json({ email: 'member-denied@example.test', role: 'member' })
      ).status(),
      403
    )
    assert.deepEqual(await snapshot(), beforeRole)

    const beforeEscalation = await snapshot()
    assert.equal(
      (
        await client
          .post('/api/v1/account/invitations')
          .bearerToken(ownerToken)
          .json({ email: 'escalation@example.test', role: 'owner' })
      ).status(),
      403
    )
    assert.deepEqual(await snapshot(), beforeEscalation)

    // Only `member` is invitable; a case variant or an unknown role is not a member invitation.
    for (const role of ['Owner', 'admin']) {
      assert.equal(
        (
          await client
            .post('/api/v1/account/invitations')
            .bearerToken(ownerToken)
            .json({ email: 'unlisted-role@example.test', role })
        ).status(),
        403
      )
    }
    assert.deepEqual(await snapshot(), beforeEscalation)

    assert.equal(
      (
        await client
          .post('/api/v1/account/invitations')
          .bearerToken(ownerToken)
          .json({ email: 'new-member@example.test', role: 'member' })
      ).status(),
      201
    )
    assert.lengthOf(sentInvitations, 1)
    const token = new URL(sentInvitations[0]).pathname.split('/').at(-1)!
    const invitationPath = `/api/v1/auth/invitations/${encodeURIComponent(token)}`
    const inspected = await client.get(invitationPath)
    assert.equal(inspected.status(), 200)
    assert.equal(inspected.header('cache-control'), 'no-store')
    assert.equal(inspected.header('referrer-policy'), 'no-referrer')

    const beforeMalformed = await snapshot()
    const malformed = await client.post(invitationPath).unsafeJson('{"password":')
    assert.equal(malformed.status(), 400)
    assert.equal(malformed.header('cache-control'), 'no-store')
    assert.equal(malformed.header('referrer-policy'), 'no-referrer')
    assert.deepEqual(await snapshot(), beforeMalformed)

    const accepted = await client.post(invitationPath).json({
      password: 'InvitedPass123!',
      passwordConfirmation: 'InvitedPass123!',
      fullName: 'Invited Member',
    })
    assert.equal(accepted.status(), 201)
    assert.equal(accepted.header('cache-control'), 'no-store')
    assert.equal(accepted.header('referrer-policy'), 'no-referrer')
    const invited = await User.findByOrFail('email', 'new-member@example.test')
    assert.equal(invited.fullName, 'Invited Member')
    assert.deepEqual(await db.from('app_user_roles').where('user_id', invited.id).select('role'), [
      { role: 'member' },
    ])

    const beforeReplay = await snapshot()
    assert.equal(
      (
        await client.post(invitationPath).json({
          password: 'AnotherPass123!',
          passwordConfirmation: 'AnotherPass123!',
          fullName: 'Another Member',
        })
      ).status(),
      400
    )
    assert.deepEqual(await snapshot(), beforeReplay)
  })
})
