import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { type AccountKit, defineConfig } from '../src/account_kit.js'
import {
  EmailAlreadyRegisteredError,
  InvalidInputError,
  InvalidTokenError,
  PostCommitError,
} from '../src/errors.js'
import { transaction } from '../src/db.js'
import type { AccountKitConfig, AccountUser } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import {
  allowAll,
  insertUser,
  makeConfig,
  type makeNotify,
  makeService,
  makeUsersAdapter,
  tokenFrom,
} from './helpers/fakes.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { locksRows } from './helpers/dialect.js'
import { dbTime } from './helpers/db_time.js'

test.group('invitations.accept', (group) => {
  const kit = useTestApp(group)

  const createActor = (email = 'actor@example.test') => insertUser(kit, { email })

  const service = (overrides: Partial<AccountKitConfig> = {}) => makeService(kit, overrides)

  test('applies the shared new-password policy before consuming an invitation', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service({
      passwordPolicy: { mixedCase: true, numbers: true, minScore: 3 },
    })
    const { token } = await issue(account, recorder, actor.id)
    await assert.rejects(
      () => account.invitations.accept({ token, password: 'password123' }),
      InvalidInputError
    )
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
    await account.invitations.accept({ token, password: 'LongerPassword12345' })
  })

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
        assert.equal(
          user.emailVerifiedAt?.toISO(),
          DateTime.fromJSDate(new Date(row.email_verified_at)).toUTC().toISO()
        )
        assert.isNull(user.unverifiedEmail)
        await trx
          .from('users')
          .where('id', user.id)
          .update({ email_verified_at: dbTime(kit, DateTime.utc().plus({ days: 1 })) })
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
    assert.isNull(callbackUser?.unverifiedEmail)
    assert.notEqual(stored.password, 'newPassword123')
    assert.isTrue(await kit.hash.verify(stored.password, 'newPassword123'))
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
  })

  test('emits the accepted event once after a committed cleanup fault', async ({ assert }) => {
    const actor = await createActor()
    const failure = new Error('listener failed after commit')
    const events: string[] = []
    let armed = false
    const { account, recorder } = service({
      onInvitationAccepted: async (_user, _invitation, trx) => {
        if (!armed) return
        trx.on('commit', () => {
          throw failure
        })
      },
      onLifecycleEvent: async (event) => {
        events.push(event.type)
      },
    })
    const { token } = await issue(account, recorder, actor.id)
    events.length = 0
    armed = true
    try {
      await account.invitations.accept({ token, password: 'newPassword123' })
      assert.fail('expected committed failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.isTrue((error as PostCommitError).committed)
      assert.equal((error as PostCommitError).cause, failure)
    }
    assert.deepEqual(events, ['invitation.accepted'])
    assert.isNotNull(await kit.db.from('users').where('email', 'person@example.test').first())
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
      .update({ expires_at: dbTime(kit, DateTime.utc().minus({ seconds: 1 })) })
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
          unverifiedEmail: null,
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
            unverifiedEmail: null,
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

  if (locksRows) {
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
              unverifiedEmail: null,
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

async function generatedInvitationAcceptanceHook(kit: ReturnType<typeof useTestApp>) {
  const stubsRoot = fileURLToPath(new URL('../stubs', import.meta.url))
  const stubs = await kit.app.stubs.create()
  const stub = await stubs.build('config/account_kit.stub', { source: stubsRoot })
  const rendered = await stub.prepare({
    config: { destination: join(tmpdir(), 'account_kit_generated_config.ts') },
  })
  const sourceFile = ts.createSourceFile(
    'account_kit_generated_config.ts',
    rendered.contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  let initializer: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'onInvitationAccepted'
    ) {
      initializer = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!initializer) throw new Error('Rendered config is missing onInvitationAccepted')

  const javascript = ts.transpileModule(
    `const hook = ${initializer.getText(sourceFile)}; export default hook`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }
  ).outputText
  const imported = await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  )
  return imported.default as (...args: never[]) => Promise<void>
}

test.group('generated invitation acceptance setup hook', (group) => {
  const kit = useTestApp(group)

  test('requires the acceptance hook to be present and callable when invitations are enabled', ({
    assert,
  }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash), enabled: ['invitations'] })
    assert.throws(
      () => defineConfig({ ...base, onInvitationAccepted: undefined }),
      /onInvitationAccepted must be a function/
    )
    assert.throws(
      () => defineConfig({ ...base, onInvitationAccepted: 'not callable' } as never),
      /onInvitationAccepted must be a function/
    )
  })

  test('the rendered placeholder throws inside acceptance and rolls back user and token consumption', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'inviter@example.test' })
    const hook = await generatedInvitationAcceptanceHook(kit)
    const { account, recorder } = makeService(kit, {
      minRequestMs: 0,
      onInvitationAccepted: hook as never,
    })
    const invitation = await account.invitations.send({
      actorId: actor.id,
      email: 'invitee@example.test',
      role: 'member',
    })
    const token = tokenFrom(recorder.calls[0].args[1])

    await assert.rejects(
      () => account.invitations.accept({ token, password: 'new-password123' }),
      'account_kit: implement onInvitationAccepted in config/account_kit.stub'
    )
    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 0)
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
    assert.lengthOf(recorder.calls, 1)
  })
})
