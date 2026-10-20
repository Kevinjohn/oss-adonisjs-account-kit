import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import type { AccountKit } from 'adonisjs-account-kit'
import { InvalidTokenError } from 'adonisjs-account-kit'
import type dbService from '@adonisjs/lucid/services/db'
import type UserModel from './user.js'

type User = InstanceType<typeof UserModel>
type Database = typeof dbService

type InvitationContext = {
  account: AccountKit
  db: Database
  profile: User
  User: typeof UserModel
  databaseName: string
  tokenFromUrl(value: string | undefined): string
  notifications: { invitationUrl?: string }
}

export async function runInvitationContention({
  account,
  db,
  profile,
  User,
  databaseName,
  tokenFromUrl,
  notifications,
}: InvitationContext) {
  const startedAt = performance.now()
  const invitation = await account.invitations.send({
    actorId: profile.id,
    email: 'invited@example.test',
    role: 'member',
  })
  console.log('MINIMUM_STAGE invitation-sent')
  assert.ok(invitation.id > 0)
  const invitationToken = tokenFromUrl(notifications.invitationUrl)
  const accepts = await Promise.allSettled([
    account.invitations.accept({
      token: invitationToken,
      password: 'InvitedPass123!',
      registrationData: { fullName: 'Invited Member' },
    }),
    account.invitations.accept({
      token: invitationToken,
      password: 'InvitedPass123!',
      registrationData: { fullName: 'Invited Member' },
    }),
  ])
  console.log('MINIMUM_STAGE contention-complete')
  const elapsedMs = Math.round(performance.now() - startedAt)
  assert.equal(accepts.filter((result) => result.status === 'fulfilled').length, 1)
  const rejected = accepts.find((result) => result.status === 'rejected')
  assert.equal(rejected?.status, 'rejected')
  assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof InvalidTokenError)
  const invited = await User.findByOrFail('email', 'invited@example.test')
  const invitedName = invited.fullName
  assert.equal(invitedName, 'Invited Member')
  const roleAssignmentCount = await db.from('role_assignments').count('* as count').first()
  assert.equal(Number(roleAssignmentCount.count), 1)
  console.log(
    `MINIMUM_CONTENTION_SMOKE ${JSON.stringify({ database: databaseName, elapsedMs, fulfilled: 1, rejected: 1 })}`
  )
}
