import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { AccountKit } from 'adonisjs-account-kit'
import User from '#models/user'
import {
  compareAccountRevisionForOwner,
  inspectAccountForOwner,
} from '#services/account_access_inspection'
import { grantAdmittedOwner } from '#tests/helpers/admission'
import { truncateDatabase } from '#tests/helpers/database'

test.group('application account access inspection', (group) => {
  group.each.setup(truncateDatabase)

  test('authorizes the caller, handles generic denial, and detects a changed revision', async ({
    assert,
  }) => {
    const owner = await User.create({
      fullName: 'Account Owner',
      email: 'owner@example.test',
      password: 'OwnerPass123!',
      emailVerifiedAt: DateTime.utc(),
    })
    const member = await User.create({
      fullName: 'Account Member',
      email: 'member@example.test',
      password: 'MemberPass123!',
      emailVerifiedAt: DateTime.utc(),
    })
    const target = await User.create({
      fullName: 'Inspected Account',
      email: 'target@example.test',
      password: 'TargetPass123!',
      emailVerifiedAt: DateTime.utc(),
    })
    const inactive = await User.create({
      fullName: 'Inactive Account',
      email: 'inactive@example.test',
      unverifiedEmail: 'inactive@example.test',
      password: 'InactivePass123!',
    })
    await grantAdmittedOwner(owner)

    assert.isNull(await inspectAccountForOwner(member, target.id))
    assert.isNull(await inspectAccountForOwner(owner, 999999))

    const inactiveSnapshot = await inspectAccountForOwner(owner, inactive.id)
    assert.isNotNull(inactiveSnapshot)
    if (!inactiveSnapshot) return
    assert.isFalse(inactiveSnapshot.account.active)

    const first = await inspectAccountForOwner(owner, target.id)
    assert.isNotNull(first)
    if (!first) return
    assert.isNull(first.revision)
    const unchanged = await compareAccountRevisionForOwner(owner, target.id, null)
    assert.equal(unchanged.outcome, 'current')
    if (unchanged.outcome !== 'current') return
    assert.isNull(unchanged.snapshot.revision)

    const accountKit = await app.container.make(AccountKit)
    await accountKit.authentication.changeRestriction({
      userId: target.id,
      change: async () => {},
    })

    assert.deepEqual(await compareAccountRevisionForOwner(member, target.id, first.revision), {
      outcome: 'denied',
    })
    const stale = await compareAccountRevisionForOwner(owner, target.id, first.revision)
    assert.equal(stale.outcome, 'changed')

    const refreshed = await inspectAccountForOwner(owner, target.id)
    assert.isNotNull(refreshed)
    if (!refreshed) return
    assert.notEqual(refreshed.revision, first.revision)

    await accountKit.authentication.changeRestriction({
      userId: target.id,
      change: async (_account, trx) => {
        await trx.table('role_assignments').insert({ user_id: target.id, role: 'disabled' })
      },
    })
    assert.isNull(await inspectAccountForOwner(owner, target.id))
  })

  test('rechecks owner permission before comparing a captured revision', async ({ assert }) => {
    const owner = await User.create({
      fullName: 'Account Owner',
      email: 'owner@example.test',
      password: 'OwnerPass123!',
      emailVerifiedAt: DateTime.utc(),
    })
    const target = await User.create({
      fullName: 'Inspected Account',
      email: 'target@example.test',
      password: 'TargetPass123!',
      emailVerifiedAt: DateTime.utc(),
    })
    await grantAdmittedOwner(owner)
    const captured = await inspectAccountForOwner(owner, target.id)
    assert.isNotNull(captured)
    if (!captured) return

    await db.from('role_assignments').where('user_id', owner.id).where('role', 'owner').delete()
    assert.deepEqual(await compareAccountRevisionForOwner(owner, target.id, captured.revision), {
      outcome: 'denied',
    })
  })

  test('propagates operational inspection failures unchanged', async ({ assert }) => {
    const owner = await User.create({
      fullName: 'Account Owner',
      email: 'owner@example.test',
      password: 'OwnerPass123!',
      emailVerifiedAt: DateTime.utc(),
    })
    const target = await User.create({
      fullName: 'Inspected Account',
      email: 'target@example.test',
      password: 'TargetPass123!',
      emailVerifiedAt: DateTime.utc(),
    })
    await grantAdmittedOwner(owner)

    const accountKit = await app.container.make(AccountKit)
    const failure = new Error('inspection database unavailable')
    const fakeAccountKit = {
      authentication: {
        ...accountKit.authentication,
        inspectAccountAccess: async () => {
          throw failure
        },
      },
    } as unknown as AccountKit
    app.container.swap(AccountKit, () => fakeAccountKit)

    let inspectionError: unknown
    let comparisonError: unknown
    try {
      await inspectAccountForOwner(owner, target.id)
    } catch (error) {
      inspectionError = error
    }
    try {
      await compareAccountRevisionForOwner(owner, target.id, null)
    } catch (error) {
      comparisonError = error
    } finally {
      app.container.restore(AccountKit)
    }

    assert.equal(inspectionError, failure)
    assert.equal(comparisonError, failure)
  })
})
