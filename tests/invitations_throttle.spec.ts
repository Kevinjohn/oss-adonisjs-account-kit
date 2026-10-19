import { test } from '@japa/runner'
import { configProvider } from '@adonisjs/core'
import { LimiterManager, stores } from '@adonisjs/limiter'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import { InvitationManagementDeniedError, ThrottledError } from '../src/errors.js'
import { bootTestApp, useTestApp } from './helpers/app.js'
import {
  allowAll,
  insertUser,
  makeConfig,
  makeService,
  makeUsersAdapter,
  tokenFrom,
} from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'
import { locksRows } from './helpers/dialect.js'

test.group('invitation budgets', (group) => {
  const kit = useTestApp(group)

  test('resend throttle leaves existing token usable', async ({ assert }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account, recorder } = makeService(kit, {
      invitationThrottle: {
        resendActor: { requests: 1, duration: '1h' },
        resendInvitation: { requests: 1, duration: '1h' },
      },
    })
    const invitation = await account.invitations.send({
      actorId: actor.id,
      email: 'invitee@example.test',
      role: 'user',
    })
    await account.invitations.resend({ actorId: actor.id, invitationId: invitation.id })
    const currentToken = tokenFrom(recorder.calls.at(-1)!.args[1])
    await assert.rejects(
      () => account.invitations.resend({ actorId: actor.id, invitationId: invitation.id }),
      ThrottledError
    )
    assert.deepEqual(await account.invitations.inspect({ token: currentToken }), {
      email: invitation.email,
      role: invitation.role,
    })
  })

  test('send actor budget limits distinct recipients', async ({ assert }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account } = makeService(kit, {
      invitationThrottle: { sendActor: { requests: 1, duration: '1h' } },
    })
    await account.invitations.send({ actorId: actor.id, email: 'first@example.test', role: 'user' })
    await assert.rejects(
      () =>
        account.invitations.send({ actorId: actor.id, email: 'second@example.test', role: 'user' }),
      ThrottledError
    )
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
  })

  test('send recipient budget spans actors', async ({ assert }) => {
    const first = await insertUser(kit, { email: 'first-actor@example.test' })
    const second = await insertUser(kit, { email: 'second-actor@example.test' })
    const { account } = makeService(kit, {
      invitationThrottle: { sendRecipient: { requests: 1, duration: '1h' } },
    })
    await account.invitations.send({
      actorId: first.id,
      email: 'invitee@example.test',
      role: 'user',
    })
    await kit.db.from('account_invitations').delete()
    await assert.rejects(
      () =>
        account.invitations.send({
          actorId: second.id,
          email: 'INVITEE@example.test',
          role: 'user',
        }),
      ThrottledError
    )
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
  })

  test('resend invitation budget spans actors', async ({ assert }) => {
    const first = await insertUser(kit, { email: 'first-actor@example.test' })
    const second = await insertUser(kit, { email: 'second-actor@example.test' })
    const { account, recorder } = makeService(kit, {
      invitationThrottle: { resendInvitation: { requests: 1, duration: '1h' } },
    })
    const invitation = await account.invitations.send({
      actorId: first.id,
      email: 'invitee@example.test',
      role: 'user',
    })
    await account.invitations.resend({ actorId: first.id, invitationId: invitation.id })
    const currentToken = tokenFrom(recorder.calls.at(-1)!.args[1])
    await assert.rejects(
      () => account.invitations.resend({ actorId: second.id, invitationId: invitation.id }),
      ThrottledError
    )
    assert.isNotNull(await account.invitations.inspect({ token: currentToken }))
  })

  test('denied resend does not spend the authorized actor budget', async ({ assert }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const budget = { resendActor: { requests: 1, duration: '1h' } }
    const { account } = makeService(kit, { invitationThrottle: budget })
    const invitation = await account.invitations.send({
      actorId: actor.id,
      email: 'invitee@example.test',
      role: 'user',
    })
    const denied = makeService(kit, {
      invitationThrottle: budget,
      authorize: { ...allowAll, manageInvitation: async () => false },
    }).account
    await assert.rejects(() =>
      denied.invitations.resend({ actorId: actor.id, invitationId: invitation.id })
    )
    const resent = await account.invitations.resend({
      actorId: actor.id,
      invitationId: invitation.id,
    })
    assert.equal(resent.id, invitation.id)
  })

  for (const change of ['permission', 'role'] as const) {
    test(`${change} change after preflight blocks the final rotation`, async ({ assert }) => {
      const actor = await insertUser(kit, { email: 'actor@example.test' })
      const { account: sender, recorder } = makeService(kit)
      const invitation = await sender.invitations.send({
        actorId: actor.id,
        email: 'invitee@example.test',
        role: 'user',
      })
      const originalToken = tokenFrom(recorder.calls.at(-1)!.args[1])
      let permission = true
      const config = defineConfig(
        makeConfig({
          users: makeUsersAdapter(kit.db, kit.hash),
          authorize: {
            ...allowAll,
            manageInvitation: async () => permission,
            invite: async (_actor, role) => role === 'user',
          },
        })
      )
      let charges = 0
      const limiter = {
        use: (options: { requests: number; duration: string }) => ({
          consume: async (key: string) => {
            await kit.limiter.use(options).consume(key)
            if (++charges === 2) {
              if (change === 'permission') permission = false
              else
                await kit.db
                  .from('account_invitations')
                  .where('id', invitation.id)
                  .update({ role: 'admin' })
            }
          },
        }),
      }
      const account = new AccountKit({
        config,
        db: kit.db,
        limiter: limiter as never,
        encryption: kit.encryption,
      })
      await assert.rejects(
        () => account.invitations.resend({ actorId: actor.id, invitationId: invitation.id }),
        InvitationManagementDeniedError
      )
      assert.equal(charges, 2)
      assert.isNotNull(await account.invitations.inspect({ token: originalToken }))
    })
  }

  if (!locksRows) {
    test('database limiter completes resend with a shared single-connection SQLite pool', async ({
      assert,
    }) => {
      const single = await bootTestApp({ sqlitePoolMax: 1 })
      try {
        await resetSchema(single)
        await single.db
          .connection()
          .getWriteClient()
          .schema.createTable('rate_limits', (table) => {
            table.string('key', 255).notNullable().primary()
            table.integer('points', 9).notNullable().defaultTo(0)
            table.bigint('expire').unsigned()
          })
        const store = await configProvider.resolve<ReturnType<typeof stores.memory>>(
          single.app,
          stores.database({ tableName: 'rate_limits' })
        )
        const limiter = new LimiterManager({ default: 'database', stores: { database: store! } })
        const users = makeUsersAdapter(single.db, single.hash)
        const config = defineConfig(makeConfig({ users }))
        const account = new AccountKit({
          config,
          db: single.db,
          limiter: limiter as never,
          encryption: single.encryption,
        })
        const actor = await insertUser(single, { email: 'actor@example.test' })
        const invitation = await account.invitations.send({
          actorId: actor.id,
          email: 'invitee@example.test',
          role: 'user',
        })
        const resent = await account.invitations.resend({
          actorId: actor.id,
          invitationId: invitation.id,
        })
        assert.equal(resent.id, invitation.id)
      } finally {
        await single.close()
      }
    }).timeout(6000)
  }
})
