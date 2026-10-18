import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { type AccountKit, defineConfig } from '../src/account_kit.js'
import {
  AuthorizationError,
  DeliveryError,
  InvalidInputError,
  InvitationNotFoundError,
  InvalidTokenError,
  PostCommitError,
} from '../src/errors.js'
import { hashToken } from '../src/tokens.js'
import { transaction } from '../src/db.js'
import type { Database } from '@adonisjs/lucid/database'
import type { AccountKitConfig, AccountUser, Trx } from '../src/types.js'
import { bootTestApp, useTestApp } from './helpers/app.js'
import {
  accountKit,
  allowAll,
  insertUser,
  makeConfig,
  makeNotify,
  makeService,
  makeUsersAdapter,
  tokenFrom,
} from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'
import { lockNotAvailableCode, locksRows } from './helpers/dialect.js'
import { dbTime } from './helpers/db_time.js'

test.group('invitations.resend and revoke', (group) => {
  const kit = useTestApp(group)

  const createActor = (email = 'actor@example.test') => insertUser(kit, { email })

  const service = (overrides: Partial<AccountKitConfig> = {}) => makeService(kit, overrides)

  async function issue(
    account: AccountKit,
    recorder: ReturnType<typeof makeNotify>,
    actorId: AccountUser['id'],
    email = 'person@example.test',
    role = 'admin'
  ) {
    const invitation = await account.invitations.send({ actorId, email, role })
    const token = tokenFrom(recorder.calls.at(-1)!.args[1])
    return { invitation, token }
  }

  test('resend rotates the token after commit, preserves invitation identity, and the new link works', async ({
    assert,
  }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    let visibleAtNotification = false
    const { account } = service({
      notify: {
        ...recorder.notify,
        invitationProvision: async (invitation, url) => {
          if (recorder.calls.length === 1) {
            const raw = tokenFrom(url)
            const committed = await kit.db
              .from('account_invitations')
              .where('id', invitation.id)
              .first()
            visibleAtNotification = committed?.token_hash === hashToken(raw)
          }
          await recorder.notify.invitationProvision(invitation, url)
        },
      },
    })
    const { invitation: original, token: oldToken } = await issue(account, recorder, actor.id)
    const resent = await account.invitations.resend({
      actorId: actor.id,
      invitationId: original.id,
    })
    assert.equal(resent.id, original.id)
    assert.equal(resent.email, original.email)
    assert.equal(resent.role, original.role)
    assert.equal(resent.inviterId, original.inviterId)
    assert.equal(resent.createdAt.toISO(), original.createdAt.toISO())
    assert.isTrue(visibleAtNotification)
    assert.lengthOf(recorder.calls, 2)
    const newToken = tokenFrom(recorder.calls[1].args[1])
    assert.notEqual(newToken, oldToken)
    const row = await kit.db.from('account_invitations').where('id', original.id).first()
    assert.equal(row.token_hash, hashToken(newToken))
    assert.isFalse(Object.values(row).includes(newToken))
    assert.isNull(await account.invitations.inspect({ token: oldToken }))
    assert.deepEqual(await account.invitations.inspect({ token: newToken }), {
      email: original.email,
      role: original.role,
    })
    await assert.rejects(
      () => account.invitations.accept({ token: oldToken, password: 'password123' }),
      InvalidTokenError
    )
    const accepted = await account.invitations.accept({ token: newToken, password: 'password123' })
    assert.equal(accepted.email, original.email)
  })

  test('resend renews an expired invitation and rejects accepted or missing ids', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    const { invitation, token } = await issue(account, recorder, actor.id)
    await kit.db
      .from('account_invitations')
      .where('id', invitation.id)
      .update({ expires_at: dbTime(kit, DateTime.utc().minus({ seconds: 1 })) })
    const renewed = await account.invitations.resend({
      actorId: actor.id,
      invitationId: invitation.id,
    })
    assert.isTrue(renewed.expiresAt > DateTime.utc())
    assert.isNull(await account.invitations.inspect({ token }))
    await account.invitations.accept({
      token: tokenFrom(recorder.calls[1].args[1]),
      password: 'password123',
    })
    await assert.rejects(
      () => account.invitations.resend({ actorId: actor.id, invitationId: invitation.id }),
      InvitationNotFoundError
    )
    await assert.rejects(
      () => account.invitations.resend({ actorId: actor.id, invitationId: 99999 }),
      InvitationNotFoundError
    )
  })

  test('send and resend return the row they wrote when other invitations exist', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    await issue(account, recorder, actor.id, 'earlier@example.test', 'member')
    const { invitation } = await issue(account, recorder, actor.id, 'later@example.test')
    assert.equal(invitation.email, 'later@example.test')
    assert.equal(invitation.role, 'admin')
    const renewed = await account.invitations.resend({
      actorId: actor.id,
      invitationId: invitation.id,
    })
    assert.equal(renewed.id, invitation.id)
    assert.equal(renewed.email, 'later@example.test')
  })

  test('resend requires exact manage and current stored-role grant before any rotation', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account: sender, recorder } = service()
    const { invitation, token } = await issue(sender, recorder, actor.id)
    const initial = await kit.db.from('account_invitations').where('id', invitation.id).first()
    const managedDenied = service({
      authorize: { ...allowAll, manageInvitation: async () => undefined as never },
    }).account
    await assert.rejects(
      () => managedDenied.invitations.resend({ actorId: actor.id, invitationId: invitation.id }),
      AuthorizationError
    )
    const roles: string[] = []
    const grantDenied = service({
      authorize: {
        ...allowAll,
        invite: async (_actor, role) => {
          roles.push(role)
          return role === 'user'
        },
      },
    }).account
    await assert.rejects(
      () => grantDenied.invitations.resend({ actorId: actor.id, invitationId: invitation.id }),
      AuthorizationError
    )
    assert.deepEqual(roles, ['admin'])
    const missingGrant = service({
      authorize: { ...allowAll, invite: async () => undefined as never },
    }).account
    await assert.rejects(
      () => missingGrant.invitations.resend({ actorId: actor.id, invitationId: invitation.id }),
      AuthorizationError
    )
    await assert.rejects(
      () => sender.invitations.resend({ actorId: 99999, invitationId: invitation.id }),
      InvalidInputError
    )
    const unchanged = await kit.db.from('account_invitations').where('id', invitation.id).first()
    assert.equal(unchanged.token_hash, initial.token_hash)
    assert.deepEqual(await sender.invitations.inspect({ token }), {
      email: invitation.email,
      role: invitation.role,
    })
  })

  test('delivery and URL failures leave the new token committed', async ({ assert }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    const { account } = service({ notify: recorder.notify })
    const { invitation, token: oldToken } = await issue(account, recorder, actor.id)
    recorder.failOn('invitationProvision')
    try {
      await account.invitations.resend({ actorId: actor.id, invitationId: invitation.id })
      assert.fail('expected delivery failure')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.instanceOf((error as DeliveryError).cause, Error)
    }
    const newToken = tokenFrom(recorder.calls[1].args[1])
    assert.isNull(await account.invitations.inspect({ token: oldToken }))
    assert.deepEqual(await account.invitations.inspect({ token: newToken }), {
      email: invitation.email,
      role: invitation.role,
    })
    const urlFailure = new Error('invitation URL failed')
    const defaults = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    const broken = service({
      urls: {
        ...defaults.urls,
        invitation: () => {
          throw urlFailure
        },
      },
    }).account
    try {
      await broken.invitations.resend({ actorId: actor.id, invitationId: invitation.id })
      assert.fail('expected URL failure')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.equal((error as DeliveryError).cause, urlFailure)
    }
    assert.isNull(await account.invitations.inspect({ token: newToken }))
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
  })

  /** Fault the commit of the nth package transaction only, counting from zero. */
  function faultNthCommit(db: Database, failure: Error, index: number): Database {
    let seen = 0
    return Object.create(db, {
      connection: {
        value: (...args: Parameters<Database['connection']>) => {
          const client = db.connection(...args)
          const begin = client.transaction.bind(client) as (...rest: unknown[]) => Promise<Trx>
          client.transaction = (async (...rest: unknown[]) => {
            const trx = await begin(...rest)
            if (seen++ === index) {
              trx.on('commit', () => {
                throw failure
              })
            }
            return trx
          }) as typeof client.transaction
          return client
        },
      },
    })
  }

  test('resend delivers the rotated token once after a committed cleanup fault', async ({
    assert,
  }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    const events: string[] = []
    const { account } = service({
      notify: recorder.notify,
      onLifecycleEvent: async (event) => {
        events.push(event.type)
      },
    })
    const { invitation, token: oldToken } = await issue(account, recorder, actor.id)
    events.length = 0
    const failure = new Error('listener failed after commit')
    const config = defineConfig(
      makeConfig({
        users: makeUsersAdapter(kit.db, kit.hash),
        notify: recorder.notify,
        onLifecycleEvent: async (event) => {
          events.push(event.type)
        },
      })
    )
    // Resend runs a preflight transaction first; the rotation is the second one.
    const faulty = accountKit({ ...kit, db: faultNthCommit(kit.db, failure, 1) }, config)
    try {
      await faulty.invitations.resend({ actorId: actor.id, invitationId: invitation.id })
      assert.fail('expected committed failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.isTrue((error as PostCommitError).committed)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.deepEqual(
      recorder.calls.map((call) => call.method),
      ['invitationProvision', 'invitationProvision']
    )
    assert.deepEqual(events, ['invitation.resent'])
    const newToken = tokenFrom(recorder.calls[1].args[1])
    assert.isNull(await account.invitations.inspect({ token: oldToken }))
    assert.deepEqual(await account.invitations.inspect({ token: newToken }), {
      email: invitation.email,
      role: invitation.role,
    })
  })

  test('revoke emits the revoked event once after a committed cleanup fault', async ({
    assert,
  }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    const events: string[] = []
    const { account } = service({ notify: recorder.notify })
    const { invitation } = await issue(account, recorder, actor.id)
    const failure = new Error('listener failed after commit')
    const config = defineConfig(
      makeConfig({
        users: makeUsersAdapter(kit.db, kit.hash),
        notify: recorder.notify,
        onLifecycleEvent: async (event) => {
          events.push(event.type)
        },
      })
    )
    const faulty = accountKit({ ...kit, db: faultNthCommit(kit.db, failure, 0) }, config)
    try {
      await faulty.invitations.revoke({ actorId: actor.id, invitationId: invitation.id })
      assert.fail('expected committed failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.isTrue((error as PostCommitError).committed)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.deepEqual(events, ['invitation.revoked'])
    assert.isNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
  })

  test('revoke checks management permission, deletes the row, and cannot repeat', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    const { invitation, token } = await issue(account, recorder, actor.id)
    const denied = service({
      authorize: { ...allowAll, manageInvitation: async () => false },
    }).account
    await assert.rejects(
      () => denied.invitations.revoke({ actorId: actor.id, invitationId: invitation.id }),
      AuthorizationError
    )
    const missingPermission = service({
      authorize: { ...allowAll, manageInvitation: async () => undefined as never },
    }).account
    await assert.rejects(
      () =>
        missingPermission.invitations.revoke({ actorId: actor.id, invitationId: invitation.id }),
      AuthorizationError
    )
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
    assert.isUndefined(
      await account.invitations.revoke({ actorId: actor.id, invitationId: invitation.id })
    )
    assert.lengthOf(await kit.db.from('account_invitations').where('id', invitation.id), 0)
    await assert.rejects(
      () => account.invitations.accept({ token, password: 'password123' }),
      InvalidTokenError
    )
    await assert.rejects(
      () => account.invitations.revoke({ actorId: actor.id, invitationId: invitation.id }),
      InvitationNotFoundError
    )
    await assert.rejects(
      () => account.invitations.revoke({ actorId: actor.id, invitationId: 99999 }),
      InvitationNotFoundError
    )
    await assert.rejects(
      () => account.invitations.revoke({ actorId: 99999, invitationId: invitation.id }),
      InvalidInputError
    )
  })

  if (!locksRows) {
    test('database-backed management policy reads use another pooled SQLite connection', async ({
      assert,
    }) => {
      const customKit = await bootTestApp({ sqlitePoolMax: 2 })
      try {
        await resetSchema(customKit)
        const users = makeUsersAdapter(customKit.db, customKit.hash)
        const actor = await customKit.db.transaction((trx) =>
          users.create(
            {
              email: 'actor@example.test',
              password: 'password123',
              unverifiedEmail: null,
            },
            trx
          )
        )
        const recorder = makeNotify()
        const knex = customKit.db.connection().getWriteClient()
        assert.equal(knex.client.pool.max, 2)
        let policy: 'manage' | 'invite' | null = null
        const policyReads: Array<{ policy: 'manage' | 'invite'; connection: string }> = []
        const invitationReads: string[] = []
        const onQuery = (query: { sql: string; __knexUid?: string }) => {
          if (policy && /select .* from [`"]?users/i.test(query.sql))
            policyReads.push({ policy, connection: query.__knexUid! })
          else if (/select .* from [`"]?account_invitations/i.test(query.sql))
            invitationReads.push(query.__knexUid!)
        }
        knex.on('query', onQuery)
        try {
          const readActor = async (id: AccountUser['id']) => {
            const row = await customKit.db.from('users').where('id', id).first()
            return row?.email === actor.email
          }
          const config = defineConfig(
            makeConfig({
              users,
              notify: recorder.notify,
              authorize: {
                ...allowAll,
                async manageInvitation(current, invitation) {
                  policy = 'manage'
                  try {
                    return invitation.inviterId === current.id && (await readActor(current.id))
                  } finally {
                    policy = null
                  }
                },
                async invite(current, role) {
                  policy = 'invite'
                  try {
                    return role === 'user' && (await readActor(current.id))
                  } finally {
                    policy = null
                  }
                },
              },
            })
          )
          const account = accountKit(customKit, config)
          const invitation = await account.invitations.send({
            actorId: actor.id,
            email: 'first@example.test',
            role: 'user',
          })
          policyReads.length = 0
          invitationReads.length = 0
          const resent = await account.invitations.resend({
            actorId: actor.id,
            invitationId: invitation.id,
          })
          assert.equal(resent.id, invitation.id)
          assert.deepEqual(
            policyReads.map((read) => read.policy),
            ['manage', 'invite', 'manage', 'invite']
          )
          assert.isNotEmpty(invitationReads)
          for (const read of policyReads) assert.notEqual(read.connection, invitationReads[0])
          const rotated = await customKit.db
            .from('account_invitations')
            .where('id', invitation.id)
            .first()
          assert.notEqual(rotated.token_hash, hashToken(tokenFrom(recorder.calls[0].args[1])))

          policyReads.length = 0
          invitationReads.length = 0
          await account.invitations.revoke({ actorId: actor.id, invitationId: invitation.id })
          assert.deepEqual(
            policyReads.map((read) => read.policy),
            ['manage']
          )
          assert.isNotEmpty(invitationReads)
          assert.notEqual(policyReads[0].connection, invitationReads[0])
          assert.lengthOf(
            await customKit.db.from('account_invitations').where('id', invitation.id),
            0
          )
        } finally {
          knex.off('query', onQuery)
        }
      } finally {
        await customKit.close()
      }
    })
  }

  test('a held resend lock makes an independent acceptance lose the old token', async ({
    assert,
  }) => {
    const actor = await createActor()
    let manageReady!: () => void
    let releaseManage!: () => void
    const ready = new Promise<void>((resolve) => {
      manageReady = resolve
    })
    const hold = new Promise<void>((resolve) => {
      releaseManage = resolve
    })
    let manageReads = 0
    const { account, recorder } = service({
      authorize: {
        ...allowAll,
        manageInvitation: async () => {
          if (++manageReads === 2) {
            manageReady()
            await hold
          }
          return true
        },
      },
    })
    const { invitation, token } = await issue(account, recorder, actor.id)
    const resending = account.invitations.resend({ actorId: actor.id, invitationId: invitation.id })
    const knex = kit.db.connection().getWriteClient()
    let attempted!: () => void
    const attemptedDelete = new Promise<void>((resolve) => {
      attempted = resolve
    })
    const onQuery = (query: { sql: string }) => {
      if (
        // PostgreSQL consumes with DELETE ... RETURNING; MySQL first locks the row to consume.
        (locksRows &&
          /delete from account_invitations|from `account_invitations` .* for update/i.test(
            query.sql
          )) ||
        (!locksRows && /update account_transaction_lock set version = version/i.test(query.sql))
      )
        attempted()
    }
    knex.on('query', onQuery)
    try {
      await ready
      const accepting = account.invitations.accept({ token, password: 'password123' })
      void accepting.catch(() => {})
      await attemptedDelete
      releaseManage()
      const rotated = await resending
      await assert.rejects(() => accepting, InvalidTokenError)
      assert.equal(rotated.id, invitation.id)
      assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 0)
      assert.isNull(await account.invitations.inspect({ token }))
    } finally {
      releaseManage()
      knex.off('query', onQuery)
      await resending.catch(() => {})
    }
  }).timeout(6000)

  if (locksRows) {
    test('holds a PostgreSQL row lock through the permission callback', async ({ assert }) => {
      const actor = await createActor()
      let manageReady!: () => void
      let releaseManage!: () => void
      const ready = new Promise<void>((resolve) => {
        manageReady = resolve
      })
      const hold = new Promise<void>((resolve) => {
        releaseManage = resolve
      })
      let manageReads = 0
      const { account, recorder } = service({
        authorize: {
          ...allowAll,
          manageInvitation: async () => {
            if (++manageReads === 2) {
              manageReady()
              await hold
            }
            return true
          },
        },
      })
      const { invitation } = await issue(account, recorder, actor.id)
      const resending = account.invitations.resend({
        actorId: actor.id,
        invitationId: invitation.id,
      })
      try {
        await ready
        let conflict: unknown
        try {
          await transaction(kit.db, (trx) =>
            trx
              .rawQuery('SELECT id FROM account_invitations WHERE id = ? FOR UPDATE NOWAIT', [
                invitation.id,
              ])
              .exec()
          )
        } catch (error) {
          conflict = error
        }
        assert.equal((conflict as { code?: string } | undefined)?.code, lockNotAvailableCode)
      } finally {
        releaseManage()
        await resending
      }
    })
  }
})
