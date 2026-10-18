import { test } from '@japa/runner'
import { defineConfig } from '../src/config.js'
import {
  CapabilityDisabledError,
  DeliveryError,
  IdentityNotConfirmedError,
  PostCommitError,
  SocialProofError,
  ThrottledError,
} from '../src/errors.js'
import type { AccountKitConfig, AccountUser, LifecycleEvent, Trx } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeConfig, makeService, makeUsersAdapter } from './helpers/fakes.js'
import {
  issueRecentProof,
  seedAccountRows,
  userRowCounts,
  userTables,
} from './helpers/account_rows.js'
import { resetSchema } from './helpers/schema.js'
import { provider } from './helpers/social_identity.js'

const none = Object.fromEntries(userTables.map(([table]) => [table, 0]))

test.group('account deletion', (group) => {
  const kit = useTestApp(group)
  const events: LifecycleEvent[] = []
  group.each.setup(() => {
    events.length = 0
  })
  const service = (overrides: Partial<AccountKitConfig> = {}) =>
    makeService(kit, {
      enabled: ['accountDeletion', 'invitations'],
      authentication: { strategy: 'access_tokens', guard: 'api' },
      onLifecycleEvent: async (event) => void events.push(event),
      ...overrides,
    })
  const remove = (account: ReturnType<typeof service>['account'], actorId: AccountUser['id']) =>
    account.accountData.delete({ actorId, currentPassword: 'password123' })

  test('deletes every package row explicitly before the user row', async ({ assert }) => {
    const user = await insertUser(kit)
    const other = await insertUser(kit, { email: 'other@example.test' })
    await seedAccountRows(kit, user.id, 'a')
    await seedAccountRows(kit, other.id, 'b')
    const users = makeUsersAdapter(kit.db, kit.hash)
    const before: Array<Record<string, number>> = []
    const { account, recorder } = service({
      users: {
        ...users,
        async delete(id, trx) {
          // Foreign-key cascades would hide a missing explicit delete; check before the row goes.
          before.push(await userRowCounts(trx, id))
          await users.delete!(id, trx)
        },
      },
    })
    await remove(account, user.id)
    assert.deepEqual(before, [none])
    assert.isNull(await kit.db.from('users').where('id', user.id).first())
    assert.deepEqual(await userRowCounts(kit.db, user.id), none)
    assert.deepEqual(
      await userRowCounts(kit.db, other.id),
      Object.fromEntries(userTables.map(([table]) => [table, 1]))
    )
    assert.deepEqual(
      recorder.calls.map(({ method, args }) => [method, args]),
      [['accountDeleted', [{ id: user.id, email: 'person@example.test' }]]]
    )
    assert.lengthOf(events, 1)
    assert.deepInclude(events[0], { type: 'account.deleted', userId: user.id })
    assert.match((events[0] as { operationId: string }).operationId, /^[\da-f-]{36}$/)
  })

  test('sent invitations are revoked by default or kept without an inviter', async ({ assert }) => {
    const revoking = await insertUser(kit)
    const keeping = await insertUser(kit, { email: 'keeper@example.test' })
    await seedAccountRows(kit, revoking.id, 'a')
    await seedAccountRows(kit, keeping.id, 'b')
    await remove(service().account, revoking.id)
    assert.lengthOf(
      await kit.db.from('account_invitations').where('email', 'invitee-a@example.test'),
      0
    )

    const { account } = service({ accountDeletion: { invitations: 'keep' } })
    await remove(account, keeping.id)
    const kept = await kit.db
      .from('account_invitations')
      .where('email', 'invitee-b@example.test')
      .first()
    assert.isNull(kept.inviter_id)
    const admin = await insertUser(kit, { email: 'admin@example.test' })
    const page = await account.invitations.list({ actorId: admin.id })
    const [invited] = page.items
    assert.equal(invited.email, 'invitee-b@example.test')
    assert.isNull(invited.inviterId)
  })

  test('session apps without an access-token table delete accounts too', async ({ assert }) => {
    const user = await insertUser(kit)
    try {
      await kit.db.connection().schema.dropTable('auth_access_tokens')
      const { account } = service({ authentication: { strategy: 'session', guard: 'web' } })
      await remove(account, user.id)
      assert.isNull(await kit.db.from('users').where('id', user.id).first())
    } finally {
      await resetSchema(kit)
    }
  })

  test('the application hook runs in the transaction and its failure rolls everything back', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    await seedAccountRows(kit, user.id, 'a')
    const calls: Array<[AccountUser, boolean]> = []
    const { account, recorder } = service({
      onAccountDeletingTransaction: async (actor: AccountUser, trx: Trx) => {
        calls.push([actor, trx.isTransaction])
        await trx.from('users').where('id', actor.id).update({ email: 'renamed@example.test' })
        throw new Error('application refused')
      },
    })
    await assert.rejects(() => remove(account, user.id), /application refused/)
    assert.equal(calls[0][0].id, user.id)
    assert.isTrue(calls[0][1])
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.equal(row.email, 'person@example.test')
    assert.deepEqual(
      await userRowCounts(kit.db, user.id),
      Object.fromEntries(userTables.map(([table]) => [table, 1]))
    )
    assert.lengthOf(recorder.calls, 0)
    assert.lengthOf(events, 0)

    const { account: plain } = service({
      onAccountDeletingTransaction: async (actor: AccountUser, trx: Trx) => {
        await trx.from('account_invitations').where('inviter_id', actor.id).update({ role: 'x' })
      },
    })
    await remove(plain, user.id)
    assert.isNull(await kit.db.from('users').where('id', user.id).first())
  })

  test('a wrong password deletes nothing', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account } = service()
    await assert.rejects(
      () => account.accountData.delete({ actorId: user.id, currentPassword: 'wrong-password' }),
      IdentityNotConfirmedError
    )
    assert.isNotNull(await kit.db.from('users').where('id', user.id).first())
  })

  test('every attempt counts against the identity budget', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account } = service({ throttle: { requests: 1, duration: '1m' } })
    await assert.rejects(
      () => account.accountData.delete({ actorId: user.id, currentPassword: 'wrong-password' }),
      IdentityNotConfirmedError
    )
    await assert.rejects(() => remove(account, user.id), ThrottledError)
    assert.isNotNull(await kit.db.from('users').where('id', user.id).first())
  })

  test('a password-less account needs an account_delete proof', async ({ assert }) => {
    const user = await insertUser(kit, { password: null })
    const { account, config } = service({
      enabled: ['accountDeletion', 'socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: { providers: { github: provider('s', 'a@github.test', true) } },
    })
    const exportProof = await issueRecentProof(kit, config, user.id, 'account_export')
    await assert.rejects(
      () => account.accountData.delete({ actorId: user.id, recentProof: exportProof }),
      SocialProofError
    )
    assert.isNotNull(await kit.db.from('users').where('id', user.id).first())
    const proof = await issueRecentProof(kit, config, user.id, 'account_delete')
    await account.accountData.delete({ actorId: user.id, recentProof: proof })
    assert.isNull(await kit.db.from('users').where('id', user.id).first())
  })

  test('a failed email is a delivery error after the lifecycle event still runs', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account, recorder } = service()
    recorder.failOn('accountDeleted')
    await assert.rejects(() => remove(account, user.id), DeliveryError)
    assert.isNull(await kit.db.from('users').where('id', user.id).first())
    assert.lengthOf(events, 1)
  })

  test('a failed observer is a post-commit error after the email is still sent', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account, recorder } = service({
      onLifecycleEvent: async () => {
        throw new Error('observer down')
      },
    })
    await assert.rejects(() => remove(account, user.id), PostCommitError)
    assert.isNull(await kit.db.from('users').where('id', user.id).first())
    assert.lengthOf(recorder.calls, 1)
  })

  test('a fault after commit still sends the email and reports the event', async ({ assert }) => {
    const user = await insertUser(kit)
    const failure = new Error('commit listener failed')
    const { account, recorder } = service({
      onAccountDeletingTransaction: async (_user: AccountUser, trx: Trx) => {
        trx.on('commit', () => {
          throw failure
        })
      },
    })
    const error = await remove(account, user.id).catch((caught: unknown) => caught)
    assert.instanceOf(error, PostCommitError)
    assert.equal((error as PostCommitError).cause, failure)
    assert.isNull(await kit.db.from('users').where('id', user.id).first())
    assert.lengthOf(recorder.calls, 1)
    assert.lengthOf(events, 1)
  })

  test('deletion needs the capability, an adapter delete and the email', async ({ assert }) => {
    const user = await insertUser(kit)
    await assert.rejects(() => remove(makeService(kit).account, user.id), CapabilityDisabledError)
    const users = makeUsersAdapter(kit.db, kit.hash)
    const config = (overrides: Partial<AccountKitConfig>) =>
      defineConfig(makeConfig({ users, enabled: ['accountDeletion'], ...overrides }))
    assert.throws(
      () => config({ users: { ...users, delete: undefined } }),
      /users\.delete must be a function/
    )
    assert.throws(
      () =>
        config({
          notify: { ...makeService(kit).recorder.notify, accountDeleted: undefined as never },
        }),
      /notify\.accountDeleted must be a function/
    )
    assert.deepEqual(config({}).accountDeletion, { invitations: 'revoke' })
    assert.deepEqual(config({ accountDeletion: { invitations: 'keep' } }).accountDeletion, {
      invitations: 'keep',
    })
    assert.throws(
      () => config({ accountDeletion: { invitations: 'archive' as never } }),
      /accountDeletion\.invitations must be keep or revoke/
    )
    assert.throws(
      () => config({ accountDeletion: [] as never }),
      /accountDeletion must be an object/
    )
    for (const hook of ['exportAccountData', 'onAccountDeletingTransaction'] as const)
      assert.throws(
        () => config({ [hook]: 'yes' as never }),
        new RegExp(`${hook} must be a function`)
      )
  })
})
