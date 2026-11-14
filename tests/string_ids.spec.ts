import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import { SessionNotFoundError } from '../src/errors.js'
import type { AccountKitConfig, UsersAdapter } from '../src/types.js'
import { bootTestApp } from './helpers/app.js'
import {
  accountKit,
  makeConfig,
  makeNotify,
  makeService,
  makeUsersAdapter,
  tokenFrom,
  unwrapId,
} from './helpers/fakes.js'
import { accessTokenDefaults } from './helpers/access_tokens.js'
import { resetSchema } from './helpers/schema.js'
import { dbTime } from './helpers/db_time.js'
test('account workflows support string user IDs with matching application-owned foreign keys', async ({
  assert,
}) => {
  const kit = await bootTestApp()
  try {
    await resetSchema(kit, { stringUserIds: true })
    const base = makeUsersAdapter(kit.db, kit.hash)
    const users: UsersAdapter = {
      ...base,
      async create(attrs, trx) {
        const id = randomUUID()
        await trx.table('users').insert({
          id,
          email: attrs.email.trim().toLowerCase(),
          password: attrs.password === null ? null : await kit.hash.make(attrs.password),
          unverified_email: attrs.unverifiedEmail,
          email_verified_at: null,
          created_at: dbTime(kit, DateTime.utc()),
        })
        return (await base.findById(id, trx))!
      },
    }
    const actor = await kit.db.transaction((trx) =>
      users.create(
        {
          email: 'actor@example.test',
          password: 'originalPassword123',
          unverifiedEmail: null,
        },
        trx
      )
    )
    const recorder = makeNotify()
    const account = accountKit(
      kit,
      defineConfig(makeConfig({ users, notify: recorder.notify, minRequestMs: 0 }))
    )
    const invitation = await account.invitations.send({
      actorId: actor.id,
      email: 'invited@example.test',
      role: 'member',
    })
    assert.equal(invitation.inviterId, actor.id)
    const invitationCall = recorder.calls.find((call) => call.method === 'invitationProvision')!
    const invitationToken = tokenFrom(invitationCall.args[1])
    const invited = await account.invitations.accept({
      token: invitationToken,
      password: 'invitedPassword123',
    })
    assert.isString(invited.id)
    assert.match(String(invited.id), /^[a-f\d-]{36}$/)

    await account.passwordReset.request({ email: actor.email, clientKey: 'text-id-client' })
    const recoveryCall = recorder.calls.find((call) => call.method === 'passwordResetProvision')!
    const recoveryToken = tokenFrom(recoveryCall.args[1])
    const reset = await account.passwordReset.reset({
      token: recoveryToken,
      password: 'resetPassword123',
    })
    assert.equal(reset.id, actor.id)
    await account.emailPasswordManagement.requestEmailChange({
      actorId: actor.id,
      currentPassword: 'resetPassword123',
      newEmail: 'changed@example.test',
    })
    const emailCall = recorder.calls.find((call) => call.method === 'emailChangeProvision')!
    const emailToken = tokenFrom(emailCall.args[2])
    const changed = await account.emailPasswordManagement.completeEmailChange({ token: emailToken })
    assert.equal(changed.id, actor.id)
    assert.equal(changed.email, 'changed@example.test')
    // Leave live rows keyed by the text ID, so only the foreign-key cascade can remove them.
    await account.passwordReset.request({ email: changed.email, clientKey: 'text-id-cascade' })
    await account.emailPasswordManagement.requestEmailChange({
      actorId: actor.id,
      currentPassword: 'resetPassword123',
      newEmail: 'later@example.test',
    })
    assert.lengthOf(await kit.db.from('password_reset_tokens').where('tokenable_id', actor.id), 1)
    assert.lengthOf(
      await kit.db.from('email_verification_tokens').where('tokenable_id', actor.id),
      1
    )
    await kit.db.from('users').where('id', actor.id).delete()
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
  } finally {
    await kit.close()
  }
})

/** A booted app with string user ids, and helpers that seed users and tokens keyed by them. */
async function withStringIds(
  body: (context: {
    kit: Awaited<ReturnType<typeof bootTestApp>>
    addUser: (email: string) => Promise<string>
    addToken: (userId: string, name: string) => Promise<number>
    service: (overrides?: Partial<AccountKitConfig>) => ReturnType<typeof makeService>
  }) => Promise<void>
): Promise<void> {
  const kit = await bootTestApp()
  try {
    await resetSchema(kit, { stringUserIds: true })
    const addUser = async (email: string) => {
      const id = randomUUID()
      await kit.db.table('users').insert({
        id,
        email,
        unverified_email: null,
        password: await kit.hash.make('password123'),
        email_verified_at: dbTime(kit),
        created_at: dbTime(kit),
      })
      return id
    }
    const addToken = async (userId: string, name: string) => {
      const [row] = await kit.db
        .table('auth_access_tokens')
        .insert({
          tokenable_id: userId,
          ...accessTokenDefaults,
          name,
          hash: `hash-${userId}-${name}`,
          created_at: dbTime(kit),
        })
        .returning('id')
      return Number(unwrapId(row))
    }
    const service = (overrides: Partial<AccountKitConfig> = {}) =>
      makeService(kit, {
        enabled: [
          'sessionManagement',
          'dataExport',
          'accountDeletion',
          'emailVerification',
          'emailPasswordManagement',
        ],
        authentication: { strategy: 'access_tokens', guard: 'api' },
        minRequestMs: 0,
        ...overrides,
      })
    await body({ kit, addUser, addToken, service })
  } finally {
    await kit.close()
  }
}

const tokenIds = async (kit: Awaited<ReturnType<typeof bootTestApp>>, userId: string) => {
  const rows = await kit.db.from('auth_access_tokens').where('tokenable_id', userId).orderBy('id')
  return rows.map((row) => Number(row.id))
}

test('sign-in issues an access token owned by a string user id', async ({ assert }) => {
  await withStringIds(async ({ kit, addUser, service }) => {
    const userId = await addUser('person@example.test')
    const { account } = service()
    const guard = {
      strategy: 'access_tokens' as const,
      name: 'api',
      establish: async (id: string | number) => {
        const [row] = await kit.db
          .table('auth_access_tokens')
          .insert({ tokenable_id: id, ...accessTokenDefaults, hash: 'issued' })
          .returning('id')
        return unwrapId(row)
      },
      terminate: async () => {},
    }
    const signedIn = await account.authentication.login(
      { email: 'person@example.test', password: 'password123', clientKey: 'string-ids' },
      guard
    )
    const row = await kit.db.from('auth_access_tokens').first()
    assert.strictEqual(row.tokenable_id, userId)
    const current = await account.authentication.current({
      userId,
      tokenId: signedIn.credential,
    })
    assert.strictEqual(current.id, userId)
  })
})

test('lists only the string-id caller tokens and marks the current one', async ({ assert }) => {
  await withStringIds(async ({ addUser, addToken, service }) => {
    const userId = await addUser('person@example.test')
    const otherId = await addUser('other@example.test')
    const { account } = service()
    const phone = await addToken(userId, 'Phone')
    const laptop = await addToken(userId, 'Laptop')
    await addToken(otherId, 'Theirs')
    const list = await account.authentication.sessions.list({ current: { userId, tokenId: phone } })
    assert.deepEqual(
      list.map(({ id, label, current }) => [id, label, current]),
      [
        [laptop, 'Laptop', false],
        [phone, 'Phone', true],
      ]
    )
  })
})

test('revokes string-id tokens one by one and never another user token', async ({ assert }) => {
  await withStringIds(async ({ kit, addUser, addToken, service }) => {
    const userId = await addUser('person@example.test')
    const otherId = await addUser('other@example.test')
    const { account } = service()
    const phone = await addToken(userId, 'Phone')
    const laptop = await addToken(userId, 'Laptop')
    const theirs = await addToken(otherId, 'Theirs')
    const current = { userId, tokenId: phone }
    await assert.rejects(
      () => account.authentication.sessions.revoke({ current, id: theirs }),
      SessionNotFoundError
    )
    assert.deepEqual(await account.authentication.sessions.revoke({ current, id: laptop }), {
      current: false,
    })
    assert.deepEqual(await tokenIds(kit, userId), [phone])
    await account.authentication.sessions.revokeAll({ current })
    assert.deepEqual(await tokenIds(kit, userId), [])
    assert.deepEqual(await tokenIds(kit, otherId), [theirs])
  })
})

test('a password change revokes the string-id user tokens and keeps other users', async ({
  assert,
}) => {
  await withStringIds(async ({ kit, addUser, addToken, service }) => {
    const userId = await addUser('person@example.test')
    const otherId = await addUser('other@example.test')
    const { account } = service()
    await addToken(userId, 'Phone')
    await addToken(userId, 'Laptop')
    const theirs = await addToken(otherId, 'Theirs')
    await account.emailPasswordManagement.changePassword({
      actorId: userId,
      currentPassword: 'password123',
      newPassword: 'replacement123',
    })
    assert.deepEqual(await tokenIds(kit, userId), [])
    assert.deepEqual(await tokenIds(kit, otherId), [theirs])
  })
})

test('deleting a string-id account removes its tokens before the user row', async ({ assert }) => {
  await withStringIds(async ({ kit, addUser, addToken, service }) => {
    const userId = await addUser('person@example.test')
    const otherId = await addUser('other@example.test')
    const users = makeUsersAdapter(kit.db, kit.hash)
    await addToken(userId, 'Phone')
    const theirs = await addToken(otherId, 'Theirs')
    const before: number[][] = []
    const { account } = service({
      users: {
        ...users,
        async delete(id, trx) {
          // The foreign key would cascade the rows away; check they are gone before it can.
          const rows = await trx.from('auth_access_tokens').where('tokenable_id', id)
          before.push(rows.map((row) => Number(row.id)))
          await users.delete!(id, trx)
        },
      },
    })
    await account.accountData.delete({ actorId: userId, currentPassword: 'password123' })
    assert.deepEqual(before, [[]])
    assert.isNull(await kit.db.from('users').where('id', userId).first())
    assert.deepEqual(await tokenIds(kit, otherId), [theirs])
  })
})

test('exports only the string-id user tokens', async ({ assert }) => {
  await withStringIds(async ({ addUser, addToken, service }) => {
    const userId = await addUser('person@example.test')
    const otherId = await addUser('other@example.test')
    const { account } = service()
    const phone = await addToken(userId, 'Phone')
    const laptop = await addToken(userId, 'Laptop')
    await addToken(otherId, 'Theirs')
    const document = await account.accountData.export({
      actorId: userId,
      currentPassword: 'password123',
    })
    assert.deepEqual(
      document.accessTokens!.map(({ id, name }) => [Number(id), name]),
      [
        [phone, 'Phone'],
        [laptop, 'Laptop'],
      ]
    )
  })
})
