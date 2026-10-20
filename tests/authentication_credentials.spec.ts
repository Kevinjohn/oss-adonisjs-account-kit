/* eslint-disable @unicorn/no-await-expression-member -- Keep database assertions next to the operation they inspect. */

import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService, tokenFrom, unwrapId } from './helpers/fakes.js'
import { advanceCredentialRevision } from '../src/authentication.js'
import { transaction } from '../src/db.js'
import { dbTime } from './helpers/db_time.js'

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
          .update({ disabled_at: dbTime(kit) })
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

  test('authentication-only restriction restoration leaves the old token revoked', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      enabled: [],
      authentication: {
        strategy: 'access_tokens',
        guard: 'api',
        canAccess: async (candidate, trx) =>
          !(await trx.from('users').select('disabled_at').where('id', candidate.id).first())
            ?.disabled_at,
      },
    })
    let issued = 0
    const guard = {
      strategy: 'access_tokens' as const,
      name: 'api',
      establish: async (id: number | string) => {
        const [tokenId] = await kit.db
          .table('auth_access_tokens')
          .insert({ tokenable_id: id, hash: `issued-${++issued}` })
          .returning('id')
        return unwrapId(tokenId)
      },
      terminate: async () => {},
    }
    const original = await account.authentication.login(
      { email: user.email, password: 'password123', clientKey: 'before' },
      guard
    )
    await account.authentication.current({ userId: user.id, tokenId: original.credential })
    await account.authentication.changeRestriction({
      userId: user.id,
      change: async (_candidate, trx) => {
        await trx
          .from('users')
          .where('id', user.id)
          .update({ disabled_at: dbTime(kit) })
      },
    })
    await account.authentication.changeRestriction({
      userId: user.id,
      change: async (_candidate, trx) => {
        await trx.from('users').where('id', user.id).update({ disabled_at: null })
      },
    })
    const fresh = await account.authentication.login(
      { email: user.email, password: 'password123', clientKey: 'after' },
      guard
    )
    await account.authentication.current({ userId: user.id, tokenId: fresh.credential })
    await assert.rejects(
      () => account.authentication.current({ userId: user.id, tokenId: original.credential }),
      'Invalid session'
    )
  })

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
              .update({ disabled_at: dbTime(kit) })
          },
        }),
      'abort'
    )
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isNull(row.disabled_at)
    assert.isNull(row.credentials_changed_at)
    assert.lengthOf(await kit.db.from('auth_access_tokens').where('tokenable_id', user.id), 1)
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
})
