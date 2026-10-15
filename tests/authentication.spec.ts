/* eslint-disable @unicorn/no-await-expression-member -- Keep database assertions next to the operation they inspect. */

import { test } from '@japa/runner'
import { Kernel, ListLoader } from '@adonisjs/core/ace'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService, makeUsersAdapter, tokenFrom, unwrapId } from './helpers/fakes.js'
import { advanceCredentialRevision } from '../src/authentication.js'
import { transaction } from '../src/db.js'
import { AccountKit } from '../src/account_kit.js'
import RetirementImpact from '../commands/retirement_impact.js'

const sessionGuard = (events: string[] = []) => ({
  strategy: 'session' as const,
  name: 'web',
  establish: async (_id: number | string, stamp: string | null) => {
    events.push(`establish:${stamp}`)
    return stamp
  },
  terminate: async () => {
    events.push('terminate')
  },
})

test.group('authentication contract', (group) => {
  const kit = useTestApp(group)

  test('counts accounts that would lose password login from adapter truth without mutation', async ({
    assert,
  }) => {
    await insertUser(kit, { email: 'password@example.test' })
    await insertUser(kit, { email: 'provider@example.test', password: null })
    const before = await kit.db.from('users').count('* as total').first()
    const { account } = makeService(kit, { authentication: { strategy: 'session', guard: 'web' } })
    const impact = await account.authentication.retirementImpact({ passwordLogin: false })
    assert.equal(impact.inspectedAccounts, 2)
    assert.equal(impact.affectedAccounts, 1)
    assert.isTrue(Number.isFinite(Date.parse(impact.checkedAt)))
    assert.deepEqual(await kit.db.from('users').count('* as total').first(), before)
    await assert.rejects(
      () =>
        account.authentication.retirementImpact({ passwordLogin: false, providers: ['google'] }),
      /Social identity inventory is unavailable/
    )
  })

  test('booted Ace retirement inventory returns a structured count', async ({ assert }) => {
    await insertUser(kit, { email: 'password@example.test' })
    await insertUser(kit, { email: 'other@example.test', password: null })
    const { account } = makeService(kit, { authentication: { strategy: 'session', guard: 'web' } })
    kit.app.container.bindValue(AccountKit, account)
    const kernel = new Kernel(kit.app)
    kernel.addLoader(new ListLoader([RetirementImpact]))
    const result = await kernel.exec<typeof RetirementImpact>('account-kit:retirement-impact', [
      '--quiet',
    ])
    assert.isNotNull(result.impact)
    if (!result.impact) throw new Error('Missing retirement impact')
    assert.equal(result.impact.inspectedAccounts, 2)
    assert.equal(result.impact.affectedAccounts, 1)
  })

  test('retirement inventory follows configured string IDs and user table', async ({ assert }) => {
    await kit.db.connection().schema.createTable('retirement_users', (table) => {
      table.string('id', 254).primary()
      table.string('email')
      table.string('password').nullable()
      table.string('unverified_email').nullable()
      table.timestamp('email_verified_at').nullable()
    })
    try {
      await kit.db.table('retirement_users').insert([
        { id: 'acct-a', email: 'a@example.test', password: await kit.hash.make('password123') },
        { id: 'acct-b', email: 'b@example.test', password: null },
      ])
      const { account } = makeService(kit, {
        users: makeUsersAdapter(kit.db, kit.hash, 'retirement_users'),
        usersTable: 'retirement_users',
        authentication: { strategy: 'session', guard: 'web' },
      })
      const impact = await account.authentication.retirementImpact({ passwordLogin: false })
      assert.equal(impact.inspectedAccounts, 2)
      assert.equal(impact.affectedAccounts, 1)
    } finally {
      await kit.db.connection().schema.dropTable('retirement_users')
    }
  })

  test('rejects invalid credentials with one public error and counts failures only', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { strategy: 'access_tokens', guard: 'api' },
    })
    const issued: string[] = []
    const guard = {
      strategy: 'access_tokens' as const,
      name: 'api',
      establish: async () => {
        issued.push('token')
        return 'token'
      },
      terminate: async () => {},
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      await assert.rejects(
        () =>
          account.authentication.login(
            { email: user.email, password: 'wrong', clientKey: 'ip-1' },
            guard
          ),
        'Invalid email or password'
      )
    }
    await assert.rejects(
      () =>
        account.authentication.login(
          { email: user.email, password: 'password123', clientKey: 'ip-1' },
          guard
        ),
      'Too many requests'
    )
    assert.deepEqual(issued, [])
    const result = await account.authentication.login(
      { email: user.email, password: 'password123', clientKey: 'ip-2' },
      guard
    )
    assert.equal(result.credential, 'token')
    assert.deepEqual(result.account, {
      id: user.id,
      email: user.email,
      unverifiedEmail: null,
      hasPassword: true,
      active: true,
    })
  })

  test('allows a limited inactive login but denies protected access', async ({ assert }) => {
    const user = await insertUser(kit, { verified: false })
    const { account } = makeService(kit, {
      authentication: { strategy: 'session', guard: 'web' },
    })
    let revision: string | null = null
    const guard = {
      strategy: 'session' as const,
      name: 'web',
      establish: async (_id: number | string, stamp: string | null) => {
        revision = stamp
        return undefined
      },
      terminate: async () => {},
    }
    const result = await account.authentication.login(
      { email: user.email, password: 'password123', clientKey: 'ip-1' },
      guard
    )
    assert.isFalse(result.account.active)
    assert.deepEqual(
      await account.authentication.current({ userId: user.id, revision }),
      result.account
    )
    await assert.rejects(
      () => account.authentication.requireActive({ userId: user.id, revision }),
      'unverified_email'
    )
  })

  test('rejects an adapter for a different named guard before password verification', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { strategy: 'session', guard: 'web' },
    })
    await assert.rejects(
      () =>
        account.authentication.login(
          { email: user.email, password: 'password123', clientKey: 'ip-1' },
          { ...sessionGuard(), name: 'other' }
        ),
      'account_kit: expected web session guard'
    )
  })

  test('passes configured token lifetime and abilities to the selected guard', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: {
        strategy: 'access_tokens',
        guard: 'api',
        tokenAbilities: ['profile:read'],
        tokenExpiresIn: '1d',
      },
    })
    let passed: unknown[] = []
    await account.authentication.login(
      { email: user.email, password: 'password123', clientKey: 'ip-1' },
      {
        strategy: 'access_tokens',
        name: 'api',
        establish: async (_id, abilities, expiresIn) => {
          passed = [abilities, expiresIn]
          return 'opaque'
        },
        terminate: async () => {},
      }
    )
    assert.deepEqual(passed, [['profile:read'], '1d'])
  })

  test('a session with a missing or old stamp never captures a fresh revision', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { strategy: 'session', guard: 'web' },
    })
    await assert.rejects(
      () => account.authentication.current({ userId: user.id }),
      'Invalid session'
    )
    await account.authentication.changeRestriction({ userId: user.id, change: async () => {} })
    await assert.rejects(
      () => account.authentication.current({ userId: user.id, revision: null }),
      'Invalid session'
    )
  })

  test('the client budget counts failures across identities and success consumes no budget', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, { authentication: { strategy: 'session', guard: 'web' } })
    const guard = sessionGuard()
    for (let i = 0; i < 12; i++) {
      await account.authentication.login(
        { email: user.email, password: 'password123', clientKey: 'shared' },
        guard
      )
    }
    for (let i = 0; i < 10; i++) {
      await assert.rejects(
        () =>
          account.authentication.login(
            { email: `missing${i}@example.test`, password: 'wrong', clientKey: 'shared' },
            guard
          ),
        'Invalid email or password'
      )
    }
    await assert.rejects(
      () =>
        account.authentication.login(
          { email: user.email, password: 'password123', clientKey: 'shared' },
          guard
        ),
      'Too many requests'
    )
  })

  test('a successful identity cannot erase failures against another identity on the same client', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, { authentication: { strategy: 'session', guard: 'web' } })
    for (let index = 0; index < 9; index++) {
      await assert.rejects(
        () =>
          account.authentication.login(
            { email: `missing-${index}@example.test`, password: 'wrong', clientKey: 'shared' },
            sessionGuard()
          ),
        'Invalid email or password'
      )
    }
    await account.authentication.login(
      { email: user.email, password: 'password123', clientKey: 'shared' },
      sessionGuard()
    )
    await assert.rejects(
      () =>
        account.authentication.login(
          { email: 'missing-last@example.test', password: 'wrong', clientKey: 'shared' },
          sessionGuard()
        ),
      'Invalid email or password'
    )
    await assert.rejects(
      () =>
        account.authentication.login(
          { email: user.email, password: 'password123', clientKey: 'shared' },
          sessionGuard()
        ),
      'Too many requests'
    )
  })

  test('concurrent failures preserve the shared client limit', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, { authentication: { strategy: 'session', guard: 'web' } })
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        account.authentication.login(
          { email: `parallel-${index}@example.test`, password: 'wrong', clientKey: 'parallel' },
          sessionGuard()
        )
      )
    )
    assert.isTrue(attempts.every((result) => result.status === 'rejected'))
    await assert.rejects(
      () =>
        account.authentication.login(
          { email: user.email, password: 'password123', clientKey: 'parallel' },
          sessionGuard()
        ),
      'Too many requests'
    )
  })

  test('restriction changes revoke old sessions across service instances', async ({ assert }) => {
    const user = await insertUser(kit)
    const options = {
      authentication: {
        strategy: 'session' as const,
        name: 'web',
        guard: 'web',
        canAccess: async (account: { id: number | string }, trx: import('../src/types.js').Trx) =>
          !(await trx.from('users').select('disabled_at').where('id', account.id).first())
            ?.disabled_at,
      },
    }
    const first = makeService(kit, options).account
    const second = makeService(kit, options).account
    const login = await first.authentication.login(
      { email: user.email, password: 'password123', clientKey: 'ip-1' },
      sessionGuard()
    )
    await second.authentication.changeRestriction({
      userId: user.id,
      change: async (_account, trx) => {
        await trx
          .from('users')
          .where('id', user.id)
          .update({ disabled_at: new Date().toISOString() })
      },
    })
    const rejectedEvents: string[] = []
    await assert.rejects(
      () =>
        first.authentication.login(
          { email: user.email, password: 'password123', clientKey: 'ip-2' },
          sessionGuard(rejectedEvents)
        ),
      'Invalid email or password'
    )
    assert.deepEqual(rejectedEvents, [])
    await second.authentication.changeRestriction({
      userId: user.id,
      change: async (_account, trx) => {
        await trx.from('users').where('id', user.id).update({ disabled_at: null })
      },
    })
    await assert.rejects(
      () => first.authentication.current({ userId: user.id, revision: login.credential }),
      'Invalid session'
    )
  })

  for (const strategy of ['session', 'access_tokens'] as const) {
    test(`inactive email replacement revokes existing ${strategy} credentials`, async ({
      assert,
    }) => {
      const user = await insertUser(kit, { verified: false })
      const { account } = makeService(kit, {
        authentication: { strategy, guard: strategy === 'session' ? 'web' : 'api' },
      })
      const [inserted] =
        strategy === 'access_tokens'
          ? await kit.db
              .table('auth_access_tokens')
              .insert({ tokenable_id: user.id, hash: 'email-correction-token' })
              .returning('id')
          : [undefined]
      const tokenId = inserted === undefined ? undefined : unwrapId(inserted)
      await account.emailPasswordManagement.requestEmailChange({
        actorId: user.id,
        currentPassword: 'password123',
        newEmail: `corrected-${user.id}@example.test`,
      })
      const row = await kit.db.from('users').where('id', user.id).first()
      assert.equal(row.email, `corrected-${user.id}@example.test`)
      assert.isNotNull(row.credentials_changed_at)
      if (strategy === 'session') {
        await assert.rejects(
          () => account.authentication.current({ userId: user.id, revision: null }),
          'Invalid session'
        )
      } else {
        assert.lengthOf(await kit.db.from('auth_access_tokens').where('tokenable_id', user.id), 0)
        await assert.rejects(
          () => account.authentication.current({ userId: user.id, tokenId }),
          'Invalid session'
        )
      }
    })

    test(`confirmed email change revokes existing ${strategy} credentials`, async ({ assert }) => {
      const user = await insertUser(kit)
      const { account, recorder } = makeService(kit, {
        authentication: { strategy, guard: strategy === 'session' ? 'web' : 'api' },
      })
      const [inserted] =
        strategy === 'access_tokens'
          ? await kit.db
              .table('auth_access_tokens')
              .insert({ tokenable_id: user.id, hash: 'confirmed-email-token' })
              .returning('id')
          : [undefined]
      const tokenId = inserted === undefined ? undefined : unwrapId(inserted)
      await account.emailPasswordManagement.requestEmailChange({
        actorId: user.id,
        currentPassword: 'password123',
        newEmail: `confirmed-${user.id}@example.test`,
      })
      const proof = tokenFrom(
        recorder.calls.find((call) => call.method === 'emailChangeProvision')?.args[2]
      )
      if (strategy === 'session')
        await account.authentication.current({ userId: user.id, revision: null })
      else await account.authentication.current({ userId: user.id, tokenId })
      await account.emailPasswordManagement.completeEmailChange({ token: proof })
      const row = await kit.db.from('users').where('id', user.id).first()
      assert.equal(row.email, `confirmed-${user.id}@example.test`)
      assert.isNotNull(row.credentials_changed_at)
      if (strategy === 'session') {
        await assert.rejects(
          () => account.authentication.current({ userId: user.id, revision: null }),
          'Invalid session'
        )
      } else {
        assert.lengthOf(await kit.db.from('auth_access_tokens').where('tokenable_id', user.id), 0)
        await assert.rejects(
          () => account.authentication.current({ userId: user.id, tokenId }),
          'Invalid session'
        )
      }
    })
  }

  test('a credential change during provisional session establishment cannot return a usable session', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, { authentication: { strategy: 'session', guard: 'web' } })
    const events: string[] = []
    const guard = {
      strategy: 'session' as const,
      name: 'web',
      establish: async (_id: number | string, stamp: string | null) => {
        events.push('establish')
        await account.authentication.changeRestriction({ userId: user.id, change: async () => {} })
        return stamp
      },
      terminate: async () => {
        events.push('terminate')
      },
    }
    await assert.rejects(
      () =>
        account.authentication.login(
          { email: user.email, password: 'password123', clientKey: 'ip-1' },
          guard
        ),
      'Invalid email or password'
    )
    assert.deepEqual(events, ['establish', 'terminate'])
  })

  test('a password reset after old-password verification invalidates provisional token issuance', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account, recorder } = makeService(kit, {
      authentication: { strategy: 'access_tokens', guard: 'api' },
    })
    await account.passwordReset.request({ email: user.email, clientKey: 'reset-client' })
    const proof = tokenFrom(
      recorder.calls.find((call) => call.method === 'passwordResetProvision')?.args[1]
    )
    const events: string[] = []
    const guard = {
      strategy: 'access_tokens' as const,
      name: 'api',
      establish: async () => {
        events.push('issue')
        await account.passwordReset.reset({ token: proof, password: 'replacement123' })
        return 'provisional-token'
      },
      terminate: async () => {
        events.push('delete')
      },
    }
    await assert.rejects(
      () =>
        account.authentication.login(
          { email: user.email, password: 'password123', clientKey: 'ip-1' },
          guard
        ),
      'Invalid email or password'
    )
    assert.deepEqual(events, ['issue', 'delete'])
  })

  test('a reset committed before login verification rejects the old password', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account, recorder } = makeService(kit, {
      authentication: { strategy: 'access_tokens', guard: 'api' },
    })
    await account.passwordReset.request({ email: user.email, clientKey: 'reset-client' })
    const proof = tokenFrom(
      recorder.calls.find((call) => call.method === 'passwordResetProvision')?.args[1]
    )
    await account.passwordReset.reset({ token: proof, password: 'replacement123' })
    let issued = false
    await assert.rejects(
      () =>
        account.authentication.login(
          { email: user.email, password: 'password123', clientKey: 'ip-1' },
          {
            strategy: 'access_tokens',
            name: 'api',
            establish: async () => {
              issued = true
              return 'token'
            },
            terminate: async () => {},
          }
        ),
      'Invalid email or password'
    )
    assert.isFalse(issued)
  })

  test('revision advances for each change when the clock does not move', async ({ assert }) => {
    const user = await insertUser(kit)
    const { config } = makeService(kit, { authentication: { strategy: 'session', guard: 'web' } })
    const oldNow = Date.now
    Date.now = () => 1_800_000_000_000
    try {
      await transaction(kit.db, async (trx) => {
        await advanceCredentialRevision(trx, config, user.id)
      })
      const first = (await kit.db.from('users').where('id', user.id).first()).credentials_changed_at
      await transaction(kit.db, async (trx) => {
        await advanceCredentialRevision(trx, config, user.id)
      })
      const second = (await kit.db.from('users').where('id', user.id).first())
        .credentials_changed_at
      assert.isAbove(new Date(second).getTime(), new Date(first).getTime())
    } finally {
      Date.now = oldNow
    }
  })

  test('token guard revokes all user tokens in the same transaction as a password change', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { strategy: 'access_tokens', guard: 'api' },
    })
    await kit.db.table('auth_access_tokens').insert([
      { tokenable_id: user.id, hash: 'one' },
      { tokenable_id: user.id, hash: 'two' },
    ])
    await account.emailPasswordManagement.changePassword({
      actorId: user.id,
      currentPassword: 'password123',
      newPassword: 'replacement123',
    })
    assert.lengthOf(await kit.db.from('auth_access_tokens').where('tokenable_id', user.id), 0)
    assert.isNotNull(
      (await kit.db.from('users').where('id', user.id).first()).credentials_changed_at
    )
  })

  test('a token authenticated before revocation cannot pass a later protected access check', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { strategy: 'access_tokens', guard: 'api' },
    })
    const [inserted] = await kit.db
      .table('auth_access_tokens')
      .insert({ tokenable_id: user.id, hash: 'authenticated-token' })
      .returning('id')
    const tokenId = unwrapId(inserted)
    await assert.rejects(
      () => account.authentication.current({ userId: user.id }),
      'Invalid session'
    )
    await account.authentication.current({ userId: user.id, tokenId })
    await account.emailPasswordManagement.changePassword({
      actorId: user.id,
      currentPassword: 'password123',
      newPassword: 'replacement123',
    })
    await assert.rejects(
      () => account.authentication.current({ userId: user.id, tokenId }),
      'Invalid session'
    )
  })

  test('failed credential follow-up rolls back password, token deletion, and revision', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    await kit.db.table('auth_access_tokens').insert({ tokenable_id: user.id, hash: 'one' })
    const { account } = makeService(kit, {
      authentication: { strategy: 'access_tokens', guard: 'api' },
      onCredentialsChangedTransaction: async (_account, _context, trx) => {
        const inside = await trx.from('users').where('id', user.id).first()
        assert.isNotNull(inside.credentials_changed_at)
        assert.lengthOf(await trx.from('auth_access_tokens').where('tokenable_id', user.id), 0)
        throw new Error('abort')
      },
    })
    await assert.rejects(
      () =>
        account.emailPasswordManagement.changePassword({
          actorId: user.id,
          currentPassword: 'password123',
          newPassword: 'replacement123',
        }),
      'abort'
    )
    assert.lengthOf(await kit.db.from('auth_access_tokens').where('tokenable_id', user.id), 1)
    assert.isNull((await kit.db.from('users').where('id', user.id).first()).credentials_changed_at)
    assert.isTrue(
      await kit.db.transaction((trx) =>
        makeService(kit).users.verifyPassword(user.id, 'password123', trx)
      )
    )
  })

  test('restriction callback and revocation roll back together', async ({ assert }) => {
    const user = await insertUser(kit)
    await kit.db
      .table('auth_access_tokens')
      .insert({ tokenable_id: user.id, hash: 'rollback-token' })
    const { account } = makeService(kit, {
      authentication: { strategy: 'access_tokens', guard: 'api' },
      onCredentialsChangedTransaction: async (_account, _context, trx) => {
        const inside = await trx.from('users').where('id', user.id).first()
        assert.isNotNull(inside.credentials_changed_at)
        assert.lengthOf(await trx.from('auth_access_tokens').where('tokenable_id', user.id), 0)
        throw new Error('abort')
      },
    })
    await assert.rejects(
      () =>
        account.authentication.changeRestriction({
          userId: user.id,
          change: async (_account, trx) => {
            await trx
              .from('users')
              .where('id', user.id)
              .update({ disabled_at: new Date().toISOString() })
          },
        }),
      'abort'
    )
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isNull(row.disabled_at)
    assert.isNull(row.credentials_changed_at)
    assert.lengthOf(await kit.db.from('auth_access_tokens').where('tokenable_id', user.id), 1)
  })

  test('logout calls only the selected current guard and has an idempotent service result', async ({
    assert,
  }) => {
    await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { strategy: 'access_tokens', guard: 'api' },
    })
    let calls = 0
    const guard = {
      terminate: async () => {
        calls++
      },
    }
    await account.authentication.logout(guard)
    await account.authentication.logout(guard)
    assert.equal(calls, 2)
  })
})
