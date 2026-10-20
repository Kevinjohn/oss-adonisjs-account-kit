import { test } from '@japa/runner'
import { createLucidAdapter } from '../adapters/lucid.js'
import { transaction } from '../src/db.js'
import type { UsersAdapter } from '../src/types.js'
import LucidUser from './fixtures/lucid_user.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService, makeUsersAdapter, tokenFrom } from './helpers/fakes.js'

type Attrs = Parameters<UsersAdapter['create']>[0]

test.group('password hashing outside the write transaction', (group) => {
  const kit = useTestApp(group)

  /**
   * A users adapter that records the order of hashing and of every SQL statement: `statement` is
   * one run inside a transaction.
   */
  function spyAdapter(withHashing: boolean) {
    const base = makeUsersAdapter(kit.db, kit.hash)
    const events: string[] = []
    const created: Attrs[] = []
    const written: string[] = []
    const adapter: UsersAdapter = {
      ...base,
      async create(attrs, trx) {
        created.push(attrs)
        if (attrs.passwordHash === undefined) return base.create(attrs, trx)
        const user = await base.create({ ...attrs, password: null }, trx)
        await trx.from('users').where('id', user.id).update({ password: attrs.passwordHash })
        return { ...user, hasPassword: true }
      },
      async setPassword(id, password, trx) {
        written.push('setPassword')
        return base.setPassword(id, password, trx)
      },
      ...(withHashing
        ? {
            async hashPassword(password: string) {
              events.push('hash')
              return kit.hash.make(password)
            },
            async setPasswordHash(id: number | string, hash: string, trx) {
              written.push('setPasswordHash')
              await trx.from('users').where('id', id).update({ password: hash })
            },
          }
        : {}),
    }
    return { adapter, events, created, written }
  }

  /** Record every statement the database runs, marking those inside a transaction. */
  function watchStatements(events: string[]) {
    const knex = kit.db.connection().getWriteClient()
    const listener = (data: { __knexTxId?: string }) =>
      void events.push(data.__knexTxId ? 'statement' : 'outside')
    knex.on('query', listener)
    return () => void knex.off('query', listener)
  }

  function service(adapter: UsersAdapter) {
    return makeService(kit, {
      users: adapter,
      enabled: [
        'registration',
        'emailVerification',
        'invitations',
        'passwordReset',
        'emailPasswordManagement',
      ],
      minRequestMs: 0,
    })
  }

  /** Run `operation` and assert the one hash ran before the first statement in a transaction. */
  async function hashedFirst(
    assert: { isTrue(value: boolean, message?: string): void; equal(a: unknown, b: unknown): void },
    events: string[],
    operation: () => Promise<unknown>
  ) {
    events.length = 0
    const stop = watchStatements(events)
    try {
      await operation()
    } finally {
      stop()
    }
    assert.equal(events.filter((event) => event === 'hash').length, 1)
    const firstStatement = events.indexOf('statement')
    assert.isTrue(firstStatement > events.indexOf('hash'), events.join(','))
  }

  const verifies = async (email: string, password: string) => {
    const row = await kit.db.from('users').where('email', email).first()
    return kit.hash.verify(row.password, password)
  }

  test('each of the five operations hashes before its transaction opens', async ({ assert }) => {
    const spy = spyAdapter(true)
    const { account, recorder } = service(spy.adapter)
    const actor = await insertUser(kit, { email: 'actor@example.test' })

    await hashedFirst(assert, spy.events, () =>
      account.registration.register({ email: 'signup@example.test', password: 'firstPassword1' })
    )
    const activation = recorder.calls.findLast(
      (call) => call.method === 'accountActivationProvision'
    )!
    await hashedFirst(assert, spy.events, () =>
      account.emailVerification.complete({
        token: tokenFrom(activation.args[1]),
        password: 'secondPassword1',
      })
    )
    assert.isTrue(await verifies('signup@example.test', 'secondPassword1'))

    await account.invitations.send({
      actorId: actor.id,
      email: 'invitee@example.test',
      role: 'member',
    })
    const invitation = recorder.calls.at(-1)!
    await hashedFirst(assert, spy.events, () =>
      account.invitations.accept({
        token: tokenFrom(invitation.args[1]),
        password: 'invitedPassword1',
      })
    )
    assert.isTrue(await verifies('invitee@example.test', 'invitedPassword1'))

    const person = await insertUser(kit, { email: 'person@example.test' })
    await account.passwordReset.request({ email: person.email, clientKey: 'client' })
    const reset = recorder.calls.findLast((call) => call.method === 'passwordResetProvision')!
    await hashedFirst(assert, spy.events, () =>
      account.passwordReset.reset({ token: tokenFrom(reset.args[1]), password: 'resetPassword1' })
    )
    await hashedFirst(assert, spy.events, () =>
      account.emailPasswordManagement.changePassword({
        actorId: person.id,
        currentPassword: 'resetPassword1',
        newPassword: 'changedPassword1',
      })
    )
    assert.isTrue(await verifies('person@example.test', 'changedPassword1'))

    for (const attrs of spy.created) {
      assert.isNull(attrs.password)
      assert.isString(attrs.passwordHash)
    }
    assert.lengthOf(spy.created, 2)
    assert.deepEqual(spy.written, ['setPasswordHash', 'setPasswordHash', 'setPasswordHash'])
  })

  test('without hashPassword the adapter receives the plain password, as before', async ({
    assert,
  }) => {
    const spy = spyAdapter(false)
    const { account } = service(spy.adapter)
    await account.registration.register({ email: 'signup@example.test', password: 'plainPass1' })
    assert.deepEqual(
      spy.created.map((attrs) => [attrs.password, 'passwordHash' in attrs]),
      [['plainPass1', false]]
    )
    const person = await insertUser(kit, { email: 'person@example.test' })
    await account.emailPasswordManagement.changePassword({
      actorId: person.id,
      currentPassword: 'password123',
      newPassword: 'changedPassword1',
    })
    assert.deepEqual(spy.written, ['setPassword'])
  })

  test('hashPassword without setPasswordHash is a configuration error', async ({ assert }) => {
    const base = makeUsersAdapter(kit.db, kit.hash)
    assert.throws(
      () => makeService(kit, { users: { ...base, hashPassword: async () => 'hash' } }),
      'account_kit: users.setPasswordHash must be a function when users.hashPassword is set'
    )
  })

  test('the Lucid adapter stores a ready hash without its model hook hashing it again', async ({
    assert,
  }) => {
    const adapter = createLucidAdapter(async () => LucidUser)
    LucidUser.hashCalls = 0
    const hash = await adapter.hashPassword!('lucidPassword1')
    const user = await transaction(kit.db, (trx) =>
      adapter.create(
        { email: 'lucid@example.test', unverifiedEmail: null, password: null, passwordHash: hash },
        trx
      )
    )
    assert.isTrue(user.hasPassword)
    assert.isTrue(await verifies('lucid@example.test', 'lucidPassword1'))
    const next = await adapter.hashPassword!('lucidPassword2')
    await transaction(kit.db, (trx) => adapter.setPasswordHash!(user.id, next, trx))
    assert.isTrue(await verifies('lucid@example.test', 'lucidPassword2'))
    assert.isTrue(
      await transaction(kit.db, (trx) => adapter.verifyPassword(user.id, 'lucidPassword2', trx))
    )
    assert.equal(LucidUser.hashCalls, 0)

    const legacy = createLucidAdapter(async () => LucidUser, {
      verifyPassword: async (stored, password) => stored === `hashed:${password}`,
    })
    assert.isUndefined(legacy.hashPassword)
    assert.isUndefined(legacy.setPasswordHash)
  })
})
