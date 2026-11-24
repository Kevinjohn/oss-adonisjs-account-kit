import { Authenticator, errors, symbols } from '@adonisjs/auth'
import { configProvider } from '@adonisjs/core'
import { test } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import { accountKitSessionGuard } from '../src/auth/session_guard.js'
import { E_INVALID_CREDENTIALS, E_ACCOUNT_KIT_INVALID_SESSION } from '../src/errors.js'
import type { AccountUser, UserId } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeConfig, makeUsersAdapter } from './helpers/fakes.js'
import { protectedContext } from './helpers/protected_context.js'

test.group('accountKitSessionGuard', (group) => {
  const kit = useTestApp(group, { accountKitProvider: 'source' })
  const denied = new Set<UserId>()
  let broken = false
  group.each.setup(() => {
    denied.clear()
    broken = false
  })

  group.setup(() => {
    kit.app.config.set(
      'account_kit',
      defineConfig(
        makeConfig({
          users: makeUsersAdapter(kit.db, kit.hash),
          enabled: ['sessionManagement'],
          authentication: {
            strategy: 'session',
            guard: 'web',
            canAccess: async (user) => {
              if (broken) throw new Error('access check failed')
              return !denied.has(user.id)
            },
          },
        })
      )
    )
  })

  const guardUser = (user: AccountUser) => ({ getId: () => user.id, getOriginal: () => user })
  const provider = {
    [symbols.PROVIDER_REAL_USER]: undefined as unknown as AccountUser,
    createUserForGuard: async (user: AccountUser) => guardUser(user),
    async findById(id: string | number | BigInt) {
      const user = await makeUsersAdapter(kit.db, kit.hash).findById(Number(id))
      return user ? guardUser(user) : null
    },
  }

  /** A request whose session holds `data`, with `ctx.auth` over the guard. */
  async function request(data: Record<string, unknown>) {
    const factory = await accountKitSessionGuard({ provider }).resolver('web', kit.app)
    const { context, config } = await protectedContext()
    const values = new Map(Object.entries(data))
    const ctx = Object.assign(context as object, {
      response: { clearCookie() {} },
      session: {
        config,
        sessionId: 'session-id',
        get: (key: string) => values.get(key),
        put: (key: string, value: unknown) => values.set(key, value),
        forget: (key: string) => values.delete(key),
        regenerate() {},
        clear: () => values.clear(),
      },
    }) as never
    const auth = new Authenticator(ctx, { default: 'web', guards: { web: factory } })
    Object.assign(ctx, { auth })
    return { auth, guard: auth.use('web'), values }
  }

  async function signedIn() {
    const user = await insertUser(kit)
    const { guard } = await request({})
    const { session } = await guard.authenticateAsClient(user)
    return { user, session: session! }
  }

  test('a live handle and revision authenticate and set auth.user', async ({ assert }) => {
    const { user, session } = await signedIn()
    assert.deepEqual(Object.keys(session).sort(), [
      'accountKitRevision',
      'accountKitSession',
      'auth_web',
    ])
    assert.lengthOf(await kit.db.from('account_sessions').where('user_id', user.id), 1)
    const { auth, guard } = await request(session)
    await auth.authenticateUsing(['web'])
    assert.equal(auth.user?.id, user.id)
    assert.equal(guard.user?.id, user.id)
    assert.equal(guard.driverName, 'session')
  })

  test('a revoked handle, a changed revision or a missing handle fails', async ({ assert }) => {
    const { user, session } = await signedIn()
    for (const changed of [
      { ...session, accountKitRevision: 'stale' },
      { ...session, accountKitSession: undefined },
      { ...session, accountKitRevision: undefined },
    ]) {
      const { guard } = await request(changed)
      await assert.rejects(() => guard.authenticate(), errors.E_UNAUTHORIZED_ACCESS)
      assert.isUndefined(guard.user)
      // A second call keeps the failed attempt instead of looking the session up again.
      await assert.rejects(() => guard.authenticate(), errors.E_UNAUTHORIZED_ACCESS)
    }
    await kit.db.from('account_sessions').where('user_id', user.id).delete()
    const { guard } = await request(session)
    await assert.rejects(() => guard.authenticate(), errors.E_UNAUTHORIZED_ACCESS)
  })

  test('a kit check that throws leaves the request unauthenticated', async ({ assert }) => {
    const { session } = await signedIn()
    const { auth, guard } = await request(session)
    broken = true
    await assert.rejects(() => guard.authenticate(), 'access check failed')
    assert.isUndefined(guard.user)
    assert.isFalse(auth.isAuthenticated)
    await assert.rejects(() => guard.authenticate(), errors.E_UNAUTHORIZED_ACCESS)
  })

  test('authenticateAsClient refuses an account canAccess refuses', async ({ assert }) => {
    const user = await insertUser(kit)
    denied.add(user.id)
    const { guard } = await request({})
    await assert.rejects(() => guard.authenticateAsClient(user), E_INVALID_CREDENTIALS)
    assert.lengthOf(await kit.db.from('account_sessions').where('user_id', user.id), 0)
  })

  test('current and forRequest are the managed adapter for the guard context', async ({
    assert,
  }) => {
    const { user, session } = await signedIn()
    const { guard, values } = await request(session)
    assert.deepEqual(await guard.current(), {
      userId: user.id,
      revision: null,
      sessionHandle: session.accountKitSession as string,
    })
    const adapter = guard.forRequest()
    assert.equal(adapter.strategy, 'session')
    assert.equal(adapter.name, 'web')
    if (adapter.strategy !== 'session') return
    assert.equal(adapter.previousHandle?.(), session.accountKitSession)
    await adapter.establish(user.id, 'next', 'handle')
    assert.equal(values.get('accountKitRevision'), 'next')
    assert.equal(values.get('auth_web'), user.id)
    await assert.rejects(() => adapter.establish(999999, null), E_ACCOUNT_KIT_INVALID_SESSION)
  })

  test('the factory builds from a frozen empty context without touching it', async ({ assert }) => {
    const factory = await accountKitSessionGuard({
      provider: configProvider.create(async () => provider),
    }).resolver('web', kit.app)
    const guard = factory(Object.freeze({}) as never)
    assert.equal(guard.driverName, 'session')
  })
})
