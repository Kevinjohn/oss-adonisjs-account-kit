import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import {
  AuthorizationError,
  DeliveryError,
  EmailAlreadyRegisteredError,
  InvalidInputError,
  InvitationPendingError,
} from '../src/errors.js'
import { hashToken } from '../src/tokens.js'
import type { AccountKitConfig, AccountUser } from '../src/types.js'
import { bootTestApp } from './helpers/app.js'
import { allowAll, makeConfig, makeNotify, makeUsersAdapter } from './helpers/fakes.js'
import { resetSchema } from './helpers/schema.js'

test.group('invitations.send', (group) => {
  let kit: Awaited<ReturnType<typeof bootTestApp>>
  group.setup(async () => {
    kit = await bootTestApp()
  })
  group.each.setup(async () => {
    await resetSchema(kit)
    await kit.limiter.clear()
  })
  group.teardown(async () => {
    await kit.close()
  })

  async function createActor(email = 'actor@example.test'): Promise<AccountUser> {
    const users = makeUsersAdapter(kit.db, kit.hash)
    return kit.db.transaction((trx) =>
      users.create({ email, password: 'password123', emailVerifiedAt: DateTime.utc() }, trx)
    )
  }

  function service(overrides: Partial<Omit<AccountKitConfig, 'users'>> = {}) {
    const recorder = makeNotify()
    const config = defineConfig(
      makeConfig({
        users: makeUsersAdapter(kit.db, kit.hash),
        notify: recorder.notify,
        ...overrides,
      })
    )
    return {
      account: new AccountKit({
        config,
        db: kit.db,
        limiter: kit.limiter,
        encryption: null as never,
      }),
      recorder,
    }
  }

  test('stores normalized email, opaque role, inviter, hash, and timestamps; notifies after commit', async ({
    assert,
  }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    let visibleAtNotification = false
    const { account } = service({
      ttl: { invitation: '2d' },
      notify: {
        ...recorder.notify,
        invitation: async (invitation, url) => {
          visibleAtNotification = !!(await kit.db
            .from('account_invitations')
            .where('id', invitation.id)
            .first())
          await recorder.notify.invitation(invitation, url)
        },
      },
    })
    const before = DateTime.utc()
    const invitation = await account.invitations.send({
      actorId: actor.id,
      email: '  PERSON@EXAMPLE.TEST  ',
      role: 'admin',
    })
    assert.equal(invitation.email, 'person@example.test')
    assert.equal(invitation.role, 'admin')
    assert.equal(invitation.inviterId, actor.id)
    assert.isTrue(visibleAtNotification)
    assert.lengthOf(recorder.calls, 1)
    const [notified, url] = recorder.calls[0].args
    assert.deepEqual(notified, invitation)
    const raw = new URL(url as string).pathname.split('/').at(-1)!
    assert.match(raw, /^[A-Za-z0-9_-]{43}$/)
    const row = await kit.db.from('account_invitations').where('id', invitation.id).first()
    assert.equal(row.email, invitation.email)
    assert.equal(row.role, 'admin')
    assert.equal(row.inviter_id, actor.id)
    assert.equal(row.token_hash, hashToken(raw))
    assert.isFalse(Object.values(row).includes(raw))
    assert.isTrue(invitation.createdAt >= before)
    assert.isTrue(invitation.updatedAt >= before)
    assert.isTrue(invitation.expiresAt >= before.plus({ days: 2 }))
  })

  test('rejects missing actor and denied invite before writing or notifying', async ({
    assert,
  }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    const calls: string[] = []
    const { account } = service({
      notify: recorder.notify,
      authorize: {
        ...allowAll,
        invite: async (_actor, role) => {
          calls.push(role)
          return role === 'user' ? true : (undefined as never)
        },
      },
    })
    await assert.rejects(
      () => account.invitations.send({ actorId: 99999, email: 'new@example.test', role: 'user' }),
      InvalidInputError
    )
    await assert.rejects(
      () =>
        account.invitations.send({ actorId: actor.id, email: 'new@example.test', role: 'admin' }),
      AuthorizationError
    )
    assert.deepEqual(calls, ['admin'])
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
    assert.lengthOf(recorder.calls, 0)
    const allowed = await account.invitations.send({
      actorId: actor.id,
      email: 'new@example.test',
      role: 'user',
    })
    assert.equal(allowed.role, 'user')
    assert.deepEqual(calls, ['admin', 'user'])
  })

  test('rejects invalid raw email and role boundaries', async ({ assert }) => {
    const actor = await createActor()
    const { account } = service()
    for (const email of [null, 'a@b@c', 'ab', 'x'.repeat(255)])
      await assert.rejects(
        () => account.invitations.send({ actorId: actor.id, email: email as never, role: 'user' }),
        InvalidInputError
      )
    for (const role of [null, '', 'a'.repeat(65)])
      await assert.rejects(
        () =>
          account.invitations.send({
            actorId: actor.id,
            email: 'new@example.test',
            role: role as never,
          }),
        InvalidInputError
      )
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
    const boundary = await account.invitations.send({
      actorId: actor.id,
      email: 'new@example.test',
      role: 'a'.repeat(64),
    })
    assert.equal(boundary.role.length, 64)
  })

  test('registered email and live pending email reject; expired row is replaced', async ({
    assert,
  }) => {
    const actor = await createActor()
    await createActor('registered@example.test')
    const { account } = service()
    await assert.rejects(
      () =>
        account.invitations.send({
          actorId: actor.id,
          email: ' REGISTERED@EXAMPLE.TEST ',
          role: 'user',
        }),
      EmailAlreadyRegisteredError
    )
    const first = await account.invitations.send({
      actorId: actor.id,
      email: 'new@example.test',
      role: 'user',
    })
    await assert.rejects(
      () =>
        account.invitations.send({ actorId: actor.id, email: ' NEW@EXAMPLE.TEST ', role: 'admin' }),
      InvitationPendingError
    )
    await kit.db
      .from('account_invitations')
      .where('id', first.id)
      .update({ expires_at: DateTime.utc().minus({ seconds: 1 }).toISO() })
    const replacement = await account.invitations.send({
      actorId: actor.id,
      email: 'new@example.test',
      role: 'admin',
    })
    assert.notEqual(replacement.id, first.id)
    assert.equal(replacement.role, 'admin')
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
  })

  test('independent concurrent sends yield one invitation and one pending error', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    const results = await Promise.allSettled([
      account.invitations.send({ actorId: actor.id, email: 'new@example.test', role: 'user' }),
      account.invitations.send({ actorId: actor.id, email: 'NEW@EXAMPLE.TEST', role: 'user' }),
    ])
    assert.lengthOf(
      results.filter((item) => item.status === 'fulfilled'),
      1
    )
    const rejected = results.filter((item) => item.status === 'rejected') as PromiseRejectedResult[]
    assert.lengthOf(rejected, 1)
    assert.instanceOf(rejected[0].reason, InvitationPendingError)
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
    assert.lengthOf(recorder.calls, 1)
  })

  test('notification and URL failures preserve the committed invitation', async ({ assert }) => {
    const actor = await createActor()
    const recorder = makeNotify()
    recorder.failOn('invitation')
    const { account } = service({ notify: recorder.notify })
    try {
      await account.invitations.send({ actorId: actor.id, email: 'one@example.test', role: 'user' })
      assert.fail('expected delivery failure')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.instanceOf((error as DeliveryError).cause, Error)
    }
    const config = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    const urlFailure = new Error('url failed')
    const { account: brokenUrl } = service({
      urls: {
        ...config.urls,
        invitation: () => {
          throw urlFailure
        },
      },
    })
    try {
      await brokenUrl.invitations.send({
        actorId: actor.id,
        email: 'two@example.test',
        role: 'user',
      })
      assert.fail('expected URL failure')
    } catch (error) {
      assert.instanceOf(error, DeliveryError)
      assert.equal((error as DeliveryError).cause, urlFailure)
    }
    assert.lengthOf(await kit.db.from('account_invitations'), 2)
  })
})

test.group('invitations.list and inspect', (group) => {
  let kit: Awaited<ReturnType<typeof bootTestApp>>
  group.setup(async () => {
    kit = await bootTestApp()
  })
  group.each.setup(async () => {
    await resetSchema(kit)
    await kit.limiter.clear()
  })
  group.teardown(async () => {
    await kit.close()
  })

  async function createActor() {
    const users = makeUsersAdapter(kit.db, kit.hash)
    return kit.db.transaction((trx) =>
      users.create(
        { email: 'actor@example.test', password: 'password123', emailVerifiedAt: DateTime.utc() },
        trx
      )
    )
  }

  function service(overrides: Partial<Omit<AccountKitConfig, 'users'>> = {}) {
    const recorder = makeNotify()
    const config = defineConfig(
      makeConfig({
        users: makeUsersAdapter(kit.db, kit.hash),
        notify: recorder.notify,
        ...overrides,
      })
    )
    return {
      account: new AccountKit({
        config,
        db: kit.db,
        limiter: kit.limiter,
        encryption: null as never,
      }),
      recorder,
    }
  }

  test('lists only live invitations in creation order without token material', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account } = service()
    const first = await account.invitations.send({
      actorId: actor.id,
      email: 'first@example.test',
      role: 'user',
    })
    const second = await account.invitations.send({
      actorId: actor.id,
      email: 'second@example.test',
      role: 'admin',
    })
    const expired = await account.invitations.send({
      actorId: actor.id,
      email: 'expired@example.test',
      role: 'user',
    })
    await kit.db
      .from('account_invitations')
      .where('id', first.id)
      .update({ created_at: DateTime.utc().minus({ days: 2 }).toISO() })
    await kit.db
      .from('account_invitations')
      .where('id', second.id)
      .update({ created_at: DateTime.utc().minus({ days: 1 }).toISO() })
    await kit.db
      .from('account_invitations')
      .where('id', expired.id)
      .update({ expires_at: DateTime.utc().minus({ seconds: 1 }).toISO() })
    const listed = await account.invitations.list({ actorId: actor.id })
    assert.deepEqual(
      listed.map((item) => item.id),
      [first.id, second.id]
    )
    assert.equal(listed[0].email, first.email)
    assert.equal(listed[1].role, second.role)
    assert.isUndefined((listed[0] as never as { tokenHash?: string }).tokenHash)
  })

  test('list requires a known actor and exact true authorization', async ({ assert }) => {
    const actor = await createActor()
    const { account } = service({
      authorize: { ...allowAll, listInvitations: async () => undefined as never },
    })
    await assert.rejects(() => account.invitations.list({ actorId: 99999 }), InvalidInputError)
    await assert.rejects(() => account.invitations.list({ actorId: actor.id }), AuthorizationError)
  })

  test('inspect reveals only the live email and role without consuming the token', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    await account.invitations.send({
      actorId: actor.id,
      email: '  PERSON@EXAMPLE.TEST ',
      role: 'admin',
    })
    const raw = new URL(recorder.calls[0].args[1] as string).pathname.split('/').at(-1)!
    const expected = { email: 'person@example.test', role: 'admin' }
    assert.deepEqual(await account.invitations.inspect({ token: raw }), expected)
    assert.deepEqual(await account.invitations.inspect({ token: raw }), expected)
    const row = await kit.db.from('account_invitations').where('token_hash', hashToken(raw)).first()
    assert.isNotNull(row)
  })

  test('inspect returns null for malformed, unknown, and expired tokens without mutating rows', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    await account.invitations.send({ actorId: actor.id, email: 'new@example.test', role: 'user' })
    const raw = new URL(recorder.calls[0].args[1] as string).pathname.split('/').at(-1)!
    for (const value of [null, 42, '', 'invalid'])
      assert.isNull(await account.invitations.inspect({ token: value as never }))
    assert.isNull(await account.invitations.inspect({ token: 'a'.repeat(43) }))
    await kit.db
      .from('account_invitations')
      .where('token_hash', hashToken(raw))
      .update({ expires_at: DateTime.utc().minus({ seconds: 1 }).toISO() })
    assert.isNull(await account.invitations.inspect({ token: raw }))
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
  })
})
