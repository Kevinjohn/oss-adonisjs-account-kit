import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import {
  AuthorizationError,
  DeliveryError,
  EmailAlreadyRegisteredError,
  InvalidInputError,
  InvitationPendingError,
  InvalidTokenError,
} from '../src/errors.js'
import { hashToken } from '../src/tokens.js'
import { transaction } from '../src/db.js'
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

test.group('invitations.accept', (group) => {
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

  function service(overrides: Partial<AccountKitConfig> = {}) {
    const recorder = makeNotify()
    const { users, ...rest } = overrides
    const config = defineConfig(
      makeConfig({
        users: users ?? makeUsersAdapter(kit.db, kit.hash),
        notify: recorder.notify,
        ...rest,
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

  async function issue(
    account: AccountKit,
    recorder: ReturnType<typeof makeNotify>,
    actorId: AccountUser['id'],
    email = 'person@example.test',
    role = 'admin'
  ) {
    const invitation = await account.invitations.send({ actorId, email, role })
    const token = new URL(recorder.calls.at(-1)!.args[1] as string).pathname.split('/').at(-1)!
    return { invitation, token }
  }

  test('consumes the token, creates a verified hashed user, runs callback in transaction, and reloads', async ({
    assert,
  }) => {
    const actor = await createActor()
    let callbackCalls = 0
    let callbackRole: string | undefined
    let callbackUser: AccountUser | undefined
    let canInvite = true
    const { account, recorder } = service({
      authorize: { ...allowAll, invite: async () => canInvite },
      onInvitationAccepted: async (user, invitation, trx) => {
        callbackCalls++
        callbackRole = invitation.role
        callbackUser = user
        const row = await trx.from('users').where('id', user.id).first()
        assert.equal(row.email, 'person@example.test')
        await trx
          .from('users')
          .where('id', user.id)
          .update({ email_verified_at: DateTime.utc().plus({ days: 1 }).toISO() })
      },
    })
    const { invitation, token } = await issue(account, recorder, actor.id)
    canInvite = false
    const accepted = await account.invitations.accept({ token, password: 'newPassword123' })
    assert.equal(callbackCalls, 1)
    assert.equal(callbackRole, 'admin')
    assert.equal(callbackUser?.id, accepted.id)
    assert.equal(accepted.email, invitation.email)
    assert.isTrue(accepted.hasPassword)
    assert.isNotNull(accepted.emailVerifiedAt)
    const stored = await kit.db.from('users').where('id', accepted.id).first()
    assert.equal(
      accepted.emailVerifiedAt?.toISO(),
      DateTime.fromJSDate(new Date(stored.email_verified_at)).toUTC().toISO()
    )
    assert.notEqual(accepted.emailVerifiedAt?.toISO(), callbackUser?.emailVerifiedAt?.toISO())
    assert.notEqual(stored.password, 'newPassword123')
    assert.isTrue(await kit.hash.verify(stored.password, 'newPassword123'))
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
  })

  test('invalid password precedes token shape; malformed, unknown, expired, revoked and reused tokens reject', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    const { invitation, token } = await issue(account, recorder, actor.id)
    for (const password of [null, 'short', 'x'.repeat(256)])
      await assert.rejects(
        () => account.invitations.accept({ token: 'bad', password: password as never }),
        InvalidInputError
      )
    for (const value of [null, 42, 'bad', 'a'.repeat(43)])
      await assert.rejects(
        () => account.invitations.accept({ token: value as never, password: 'newPassword123' }),
        InvalidTokenError
      )
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
    await kit.db
      .from('account_invitations')
      .where('id', invitation.id)
      .update({ expires_at: DateTime.utc().minus({ seconds: 1 }).toISO() })
    await assert.rejects(
      () => account.invitations.accept({ token, password: 'newPassword123' }),
      InvalidTokenError
    )
    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 0)
    const fresh = await issue(account, recorder, actor.id, 'fresh@example.test')
    await kit.db.from('account_invitations').where('id', fresh.invitation.id).delete()
    await assert.rejects(
      () => account.invitations.accept({ token: fresh.token, password: 'newPassword123' }),
      InvalidTokenError
    )
    const again = await issue(account, recorder, actor.id, 'again@example.test')
    await account.invitations.accept({ token: again.token, password: 'newPassword123' })
    await assert.rejects(
      () => account.invitations.accept({ token: again.token, password: 'newPassword123' }),
      InvalidTokenError
    )
  })

  test('registration after send rejects and restores the invitation', async ({ assert }) => {
    const actor = await createActor()
    const users = makeUsersAdapter(kit.db, kit.hash)
    let attemptedCreate = 0
    const { account, recorder } = service({
      users: {
        ...users,
        async create(attrs, trx) {
          attemptedCreate++
          return users.create(attrs, trx)
        },
      },
    })
    const { invitation, token } = await issue(account, recorder, actor.id)
    await kit.db.transaction((trx) =>
      users.create(
        {
          email: invitation.email,
          password: 'existingPassword123',
          emailVerifiedAt: DateTime.utc(),
        },
        trx
      )
    )
    await assert.rejects(
      () => account.invitations.accept({ token, password: 'newPassword123' }),
      EmailAlreadyRegisteredError
    )
    assert.equal(attemptedCreate, 0)
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 1)
  })

  test('callback write followed by throw rolls back user and token consumption', async ({
    assert,
  }) => {
    const actor = await createActor()
    const failure = new Error('callback failed')
    const { account, recorder } = service({
      onInvitationAccepted: async (_user, _invitation, trx) => {
        await trx.from('users').where('id', actor.id).update({ email_verified_at: null })
        throw failure
      },
    })
    const { invitation, token } = await issue(account, recorder, actor.id)
    try {
      await account.invitations.accept({ token, password: 'newPassword123' })
      assert.fail('expected callback failure')
    } catch (error) {
      assert.equal(error, failure)
    }
    const actorRow = await kit.db.from('users').where('id', actor.id).first()
    assert.isNotNull(actorRow.email_verified_at)
    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 0)
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
  })

  test('independent concurrent accepts yield one user and one invalid token', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    const { invitation, token } = await issue(account, recorder, actor.id)
    const results = await Promise.allSettled([
      account.invitations.accept({ token, password: 'newPassword123' }),
      account.invitations.accept({ token, password: 'anotherPassword123' }),
    ])
    assert.lengthOf(
      results.filter((item) => item.status === 'fulfilled'),
      1
    )
    const rejected = results.filter((item) => item.status === 'rejected') as PromiseRejectedResult[]
    assert.lengthOf(rejected, 1)
    assert.instanceOf(rejected[0].reason, InvalidTokenError)
    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 1)
    assert.lengthOf(await kit.db.from('account_invitations').where('id', invitation.id), 0)
  })

  test('accept and plain registration race to one user with a mapped acceptance conflict', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    const { invitation, token } = await issue(account, recorder, actor.id)
    const users = makeUsersAdapter(kit.db, kit.hash)
    const results = await Promise.allSettled([
      account.invitations.accept({ token, password: 'newPassword123' }),
      transaction(kit.db, (trx) =>
        users.create(
          {
            email: invitation.email,
            password: 'plainPassword123',
            emailVerifiedAt: DateTime.utc(),
          },
          trx
        )
      ),
    ])
    assert.lengthOf(
      results.filter((item) => item.status === 'fulfilled'),
      1
    )
    const rejected = results.filter((item) => item.status === 'rejected') as PromiseRejectedResult[]
    assert.lengthOf(rejected, 1)
    const acceptWon = results[0].status === 'fulfilled'
    if (!acceptWon) assert.instanceOf(rejected[0].reason, EmailAlreadyRegisteredError)
    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 1)
    assert.lengthOf(
      await kit.db.from('account_invitations').where('id', invitation.id),
      acceptWon ? 0 : 1
    )
  })

  if (process.env.DB_CLIENT === 'pg') {
    test('maps a real unique-email race after the transactional precheck', async ({ assert }) => {
      const actor = await createActor()
      const users = makeUsersAdapter(kit.db, kit.hash)
      let checked!: () => void
      let release!: () => void
      const afterCheck = new Promise<void>((resolve) => {
        checked = resolve
      })
      const hold = new Promise<void>((resolve) => {
        release = resolve
      })
      const { account, recorder } = service({
        users: {
          ...users,
          async findByEmail(email, trx, options) {
            const found = await users.findByEmail(email, trx, options)
            if (trx && email === 'person@example.test' && !found) {
              checked()
              await hold
            }
            return found
          },
        },
      })
      const { invitation, token } = await issue(account, recorder, actor.id)
      const accepting = account.invitations.accept({ token, password: 'newPassword123' })
      try {
        await afterCheck
        await transaction(kit.db, (trx) =>
          users.create(
            {
              email: invitation.email,
              password: 'plainPassword123',
              emailVerifiedAt: DateTime.utc(),
            },
            trx
          )
        )
      } finally {
        release()
      }
      await assert.rejects(() => accepting, EmailAlreadyRegisteredError)
      assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 1)
      assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
    })
  }
})
