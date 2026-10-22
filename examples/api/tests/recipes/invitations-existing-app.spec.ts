/* eslint-disable @unicorn/filename-case -- P6 names acceptance specs after the recipe slug. */
/* eslint-disable @unicorn/no-await-expression-member -- Keep each assertion next to its request. */

import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import { sentInvitations } from '#services/invitation_delivery'

type Snapshot = { accounts: unknown[]; access: unknown[] }

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

test('existing app invitation routes enforce owner policy and one-time acceptance', async ({
  client,
  assert,
}) => {
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
  assert.equal((await client.get(invitationPath)).status(), 200)
  assert.equal(
    (
      await client.post(invitationPath).json({
        password: 'InvitedPass123!',
        passwordConfirmation: 'InvitedPass123!',
        fullName: 'Invited Member',
      })
    ).status(),
    201
  )
  const invited = await User.findByOrFail('email', 'new-member@example.test')
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
