import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { type AccountKit, defineConfig } from '../src/account_kit.js'
import {
  AuthorizationError,
  DeliveryError,
  EmailAlreadyRegisteredError,
  InvalidInputError,
  InvitationPendingError,
  InvitationNotFoundError,
  InvalidTokenError,
} from '../src/errors.js'
import { hashToken } from '../src/tokens.js'
import { transaction } from '../src/db.js'
import type { AccountKitConfig, AccountUser } from '../src/types.js'
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
test.group('invitations.send', (group) => {
  const kit = useTestApp(group)

  const createActor = (email = 'actor@example.test') => insertUser(kit, { email })

  const service = (overrides: Partial<AccountKitConfig> = {}) => makeService(kit, overrides)

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
    const raw = tokenFrom(url)
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
    const recorder = makeNotify()
    const { account: strictAccount } = service({ notify: recorder.notify })
    for (const email of [
      null,
      'a@b@c',
      'ab',
      '@ab',
      'ab@',
      '  @  ',
      'a b@example.test',
      'x'.repeat(255),
    ])
      await assert.rejects(
        () =>
          strictAccount.invitations.send({
            actorId: actor.id,
            email: email as never,
            role: 'user',
          }),
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
    assert.lengthOf(recorder.calls, 0)
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
  const kit = useTestApp(group)

  const createActor = (email = 'actor@example.test') => insertUser(kit, { email })

  const service = (overrides: Partial<AccountKitConfig> = {}) => makeService(kit, overrides)

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
      listed.items.map((item) => item.id),
      [first.id, second.id]
    )
    assert.equal(listed.items[0].email, first.email)
    assert.equal(listed.items[1].role, second.role)
    assert.isNull(listed.nextCursor)
    assert.isUndefined((listed.items[0] as never as { tokenHash?: string }).tokenHash)
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
    const raw = tokenFrom(recorder.calls[0].args[1])
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
    const raw = tokenFrom(recorder.calls[0].args[1])
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
    for (const password of [null, 'short', 'x'.repeat(257)])
      await assert.rejects(
        () => account.invitations.accept({ token: 'bad', password: password as never }),
        InvalidInputError
      )
    await assert.rejects(
      () => account.invitations.accept({ token: 'bad', password: '😀'.repeat(128) }),
      InvalidTokenError
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

  test('the generated invitation hook setup error rolls back user creation and token consumption', async ({
    assert,
  }) => {
    const actor = await createActor()
    const setupError = new Error(
      'account_kit: implement onInvitationAccepted in config/account_kit.stub'
    )
    const { account, recorder } = service({
      onInvitationAccepted: async () => {
        throw setupError
      },
    })
    const { invitation, token } = await issue(account, recorder, actor.id)

    try {
      await account.invitations.accept({ token, password: 'newPassword123' })
      assert.fail('expected invitation hook setup error')
    } catch (error) {
      assert.equal(error, setupError)
    }

    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 0)
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
    assert.lengthOf(recorder.calls, 1)
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
        invitation: async (invitation, url) => {
          if (recorder.calls.length === 1) {
            const raw = tokenFrom(url)
            const committed = await kit.db
              .from('account_invitations')
              .where('id', invitation.id)
              .first()
            visibleAtNotification = committed?.token_hash === hashToken(raw)
          }
          await recorder.notify.invitation(invitation, url)
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
      .update({ expires_at: DateTime.utc().minus({ seconds: 1 }).toISO() })
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
    recorder.failOn('invitation')
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

  if (process.env.DB_CLIENT !== 'pg') {
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
              emailVerifiedAt: DateTime.utc(),
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
        (process.env.DB_CLIENT === 'pg' && /delete from account_invitations/i.test(query.sql)) ||
        (process.env.DB_CLIENT !== 'pg' &&
          /update account_transaction_lock set version = version/i.test(query.sql))
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

  if (process.env.DB_CLIENT === 'pg') {
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
        assert.equal((conflict as { code?: string } | undefined)?.code, '55P03')
      } finally {
        releaseManage()
        await resending
      }
    })
  }
})
