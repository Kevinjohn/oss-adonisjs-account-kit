import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import { AccountKit } from '../src/account_kit.js'
import {
  AccountAccessDeniedError,
  CapabilityDisabledError,
  InvalidInputError,
} from '../src/errors.js'
import { readIsoTimestamp } from '../src/timestamps.js'
import type { AccountKitConfig, Trx } from '../src/types.js'
import { bootTestApp, useTestApp } from './helpers/app.js'
import { failure } from './helpers/failure.js'
import { insertUser, makeService, makeUsersAdapter } from './helpers/fakes.js'
import { testEngine } from './helpers/dialect.js'

const authentication = { strategy: 'session' as const, guard: 'web' }

test.group('account access inspection', (group) => {
  const kit = useTestApp(group)
  const service = (overrides: Partial<AccountKitConfig> = {}) =>
    makeService(kit, { authentication, ...overrides }).account

  test('1 session snapshot contains only safe account fields and validates as current', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const account = service()
    await account.authentication.changeRestriction({ userId: user.id, change: async () => {} })
    const snapshot = await account.authentication.inspectAccountAccess({
      userId: user.id,
      requireActive: true,
    })
    assert.isString(snapshot.revision)
    assert.deepEqual(snapshot.account, {
      id: user.id,
      email: user.email,
      unverifiedEmail: null,
      hasPassword: true,
      active: true,
    })
    assert.deepEqual(
      await account.authentication.current({ userId: user.id, revision: snapshot.revision }),
      snapshot.account
    )
    assert.lengthOf(await kit.db.from('account_sessions').where('user_id', user.id), 0)
    assert.lengthOf(await kit.db.from('auth_access_tokens').where('tokenable_id', user.id), 0)
  })

  test('2 access token snapshot issues no credentials', async ({ assert }) => {
    const user = await insertUser(kit)
    const account = service({ authentication: { strategy: 'access_tokens', guard: 'api' } })
    await account.authentication.changeRestriction({ userId: user.id, change: async () => {} })
    const snapshot = await account.authentication.inspectAccountAccess({
      userId: user.id,
      requireActive: true,
    })
    assert.deepEqual(snapshot.account, {
      id: user.id,
      email: user.email,
      unverifiedEmail: null,
      hasPassword: true,
      active: true,
    })
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.equal(snapshot.revision, readIsoTimestamp(row.credentials_changed_at))
    assert.lengthOf(await kit.db.from('account_sessions').where('user_id', user.id), 0)
    assert.lengthOf(await kit.db.from('auth_access_tokens').where('tokenable_id', user.id), 0)
  })

  test('3 revision starts null and follows password changes', async ({ assert }) => {
    const user = await insertUser(kit)
    const account = service()
    const initial = await account.authentication.inspectAccountAccess({
      userId: user.id,
      requireActive: true,
    })
    assert.isNull(initial.revision)
    await account.emailPasswordManagement.changePassword({
      actorId: user.id,
      currentPassword: 'password123',
      newPassword: 'newPassword123',
    })
    const row = await kit.db.from('users').where('id', user.id).first()
    const changed = await account.authentication.inspectAccountAccess({
      userId: user.id,
      requireActive: true,
    })
    assert.equal(changed.revision, readIsoTimestamp(row.credentials_changed_at))
  })

  test('4 corrupt revision is an operational error', async ({ assert }) => {
    const user = await insertUser(kit)
    await kit.db.from('users').where('id', user.id).update({ credentials_changed_at: 'garbage' })
    const error = await failure(() =>
      service().authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
    )
    assert.notInstanceOf(error, AccountAccessDeniedError)
    assert.equal(error.message, 'account_kit: unreadable timestamp value')
  }).skip(testEngine !== 'sqlite')

  test('5 all denial causes have identical public errors', async ({ assert }) => {
    const inactive = await insertUser(kit, { verified: false })
    const errors = await Promise.all([
      failure(() =>
        service().authentication.inspectAccountAccess({ userId: 999999, requireActive: true })
      ),
      failure(() =>
        service({
          authentication: { ...authentication, canAccess: async () => false },
        }).authentication.inspectAccountAccess({ userId: inactive.id, requireActive: false })
      ),
      failure(() =>
        service().authentication.inspectAccountAccess({ userId: inactive.id, requireActive: true })
      ),
    ])
    for (const error of errors) {
      assert.instanceOf(error, AccountAccessDeniedError)
      assert.equal(error.message, 'Account access denied')
      assert.equal((error as AccountAccessDeniedError).code, 'E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED')
      assert.equal((error as AccountAccessDeniedError).status, 403)
      assert.isUndefined(error.cause)
    }
  })

  test('6 inactive accounts are allowed when active is not required', async ({ assert }) => {
    const user = await insertUser(kit, { verified: false })
    const snapshot = await service().authentication.inspectAccountAccess({
      userId: user.id,
      requireActive: false,
    })
    assert.isFalse(snapshot.account.active)
  })

  test('7 confirmed account with pending different address is active', async ({ assert }) => {
    const user = await insertUser(kit)
    await kit.db
      .from('users')
      .where('id', user.id)
      .update({ unverified_email: 'pending@example.test' })
    const snapshot = await service().authentication.inspectAccountAccess({
      userId: user.id,
      requireActive: true,
    })
    assert.isTrue(snapshot.account.active)
  })

  test('8 adapter and policy share one live transaction', async ({ assert }) => {
    const user = await insertUser(kit)
    const base = makeUsersAdapter(kit.db, kit.hash)
    let adapterTrx: Trx | undefined
    let policyTrx: Trx | undefined
    const account = service({
      users: {
        ...base,
        async findById(id, trx) {
          adapterTrx = trx
          assert.isFalse(trx!.isCompleted)
          return base.findById(id, trx)
        },
      },
      authentication: {
        ...authentication,
        canAccess: async (_user, trx) => {
          policyTrx = trx
          assert.isFalse(trx.isCompleted)
          assert.isDefined(await trx.from('users').where('id', user.id).first())
          return true
        },
      },
    })
    await account.authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
    assert.strictEqual(adapterTrx, policyTrx)
  })

  test('9 policy failures propagate and nonboolean policy results are operational', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const boom = new Error('boom')
    assert.strictEqual(
      await failure(() =>
        service({
          authentication: {
            ...authentication,
            canAccess: async () => {
              throw boom
            },
          },
        }).authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
      ),
      boom
    )
    for (const value of ['yes', 1, undefined, 0]) {
      const error = await failure(() =>
        service({
          authentication: { ...authentication, canAccess: async () => value as never },
        }).authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
      )
      assert.notInstanceOf(error, AccountAccessDeniedError)
      assert.equal(error.message, 'account_kit: canAccess must resolve to a boolean')
    }
  })

  test('10 dependency denial errors become operational with their cause', async ({ assert }) => {
    const user = await insertUser(kit)
    const base = makeUsersAdapter(kit.db, kit.hash)
    const deny = async (): Promise<never> => {
      throw new AccountAccessDeniedError()
    }
    for (const overrides of [
      { authentication: { ...authentication, canAccess: deny } },
      { users: { ...base, findById: deny } },
      { users: { ...base, resolveMetadata: deny } },
    ]) {
      const error = await failure(() =>
        service(overrides).authentication.inspectAccountAccess({
          userId: user.id,
          requireActive: true,
        })
      )
      assert.notInstanceOf(error, AccountAccessDeniedError)
      assert.equal(error.message, 'account_kit: dependency threw the inspection denial error')
      assert.instanceOf(error.cause, AccountAccessDeniedError)
    }
  })

  test('11 session registry can be enabled or disabled without a session', async ({ assert }) => {
    const user = await insertUser(kit)
    for (const enabled of [
      undefined,
      [
        'passwordReset',
        'emailVerification',
        'invitations',
        'emailPasswordManagement',
        'sessionManagement',
      ] as const,
    ]) {
      const account = service(enabled ? { enabled: [...enabled] } : {})
      const snapshot = await account.authentication.inspectAccountAccess({
        userId: user.id,
        requireActive: true,
      })
      assert.equal(snapshot.account.id, user.id)
      assert.lengthOf(await kit.db.from('account_sessions').where('user_id', user.id), 0)
    }
  })

  test('12 numeric string lookup preserves the adapter numeric id', async ({ assert }) => {
    const user = await insertUser(kit)
    const snapshot = await service().authentication.inspectAccountAccess({
      userId: String(user.id),
      requireActive: true,
    })
    assert.strictEqual(snapshot.account.id, user.id)
  })

  test('13 adapter cannot substitute a different account', async ({ assert }) => {
    const a = await insertUser(kit)
    const b = await insertUser(kit, { email: 'b@example.test' })
    let policyCalls = 0
    const account = service({
      users: { ...makeUsersAdapter(kit.db, kit.hash), findById: async () => b },
      authentication: {
        ...authentication,
        canAccess: async () => {
          policyCalls++
          return true
        },
      },
    })
    const error = await failure(() =>
      account.authentication.inspectAccountAccess({ userId: a.id, requireActive: true })
    )
    assert.notInstanceOf(error, AccountAccessDeniedError)
    assert.equal(
      error.message,
      'account_kit: users adapter returned a different account than requested'
    )
    assert.equal(policyCalls, 0)
  })

  test('14 absent adapter account is denied and malformed adapter id is operational', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const base = makeUsersAdapter(kit.db, kit.hash)
    const absent = await failure(() =>
      service({
        users: { ...base, findById: async () => null },
      }).authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
    )
    assert.instanceOf(absent, AccountAccessDeniedError)
    assert.equal(absent.message, 'Account access denied')
    assert.equal((absent as AccountAccessDeniedError).code, 'E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED')
    assert.equal((absent as AccountAccessDeniedError).status, 403)
    const malformed = await failure(() =>
      service({
        users: { ...base, findById: async () => ({ ...user, id: ['1'] as never }) },
      }).authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
    )
    assert.notInstanceOf(malformed, AccountAccessDeniedError)
    assert.equal(malformed.message, 'account_kit: users adapter returned a malformed account id')
  })

  test('16 invalid inputs perform no metadata lookup adapter lookup or transaction', async ({
    assert,
  }) => {
    let lookups = 0
    let metadata = 0
    let transactions = 0
    const base = makeUsersAdapter(kit.db, kit.hash)
    const { config } = makeService(kit, {
      authentication,
      users: {
        ...base,
        findById: async () => {
          lookups++
          return null
        },
        resolveMetadata: async () => {
          metadata++
          return { table: 'users', primaryKey: 'id' }
        },
      },
    })
    const db = Object.create(kit.db, {
      connection: {
        value: (...args: Parameters<typeof kit.db.connection>) => {
          const client = kit.db.connection(...args)
          const begin = client.transaction.bind(client)
          client.transaction = ((...rest: Parameters<typeof begin>) => {
            transactions++
            return begin(...rest)
          }) as typeof client.transaction
          return client
        },
      },
    })
    const account = new AccountKit({ config, db, limiter: kit.limiter })
    for (const input of [
      undefined,
      null,
      {},
      { userId: 1 },
      { userId: 1, requireActive: 'yes' },
      { userId: '', requireActive: true },
      { userId: 1.5, requireActive: true },
      { userId: 2 ** 53, requireActive: true },
    ]) {
      assert.instanceOf(
        await failure(() => account.authentication.inspectAccountAccess(input as never)),
        InvalidInputError
      )
    }
    assert.deepEqual([lookups, metadata, transactions], [0, 0, 0])
  })

  test('17 validation precedes disabled authentication', async ({ assert }) => {
    const account = service({ authentication: undefined })
    assert.instanceOf(
      await failure(() =>
        account.authentication.inspectAccountAccess({ userId: 1, requireActive: true })
      ),
      CapabilityDisabledError
    )
    assert.instanceOf(
      await failure(() =>
        account.authentication.inspectAccountAccess({ userId: '', requireActive: true })
      ),
      InvalidInputError
    )
  })

  test('18 extra credential fields do not change the snapshot', async ({ assert }) => {
    const user = await insertUser(kit)
    const account = service()
    assert.deepEqual(
      await account.authentication.inspectAccountAccess({
        userId: user.id,
        requireActive: true,
        revision: 'x',
        expectedRevision: 'y',
        tokenId: 1,
        sessionHandle: 'h',
      } as never),
      await account.authentication.inspectAccountAccess({ userId: user.id, requireActive: true })
    )
  })

  test('19 input getters are copied once before awaiting', async ({ assert }) => {
    const a = await insertUser(kit, { verified: false })
    const b = await insertUser(kit, { email: 'b@example.test' })
    let ids = 0
    let active = 0
    const input = {
      get userId() {
        return ids++ === 0 ? a.id : b.id
      },
      get requireActive() {
        return active++ === 0
      },
    }
    assert.instanceOf(
      await failure(() => service().authentication.inspectAccountAccess(input)),
      AccountAccessDeniedError
    )
    assert.deepEqual([ids, active], [1, 1])
  })
})
