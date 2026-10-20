import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'

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

  test('every invalid-credential failure waits out the request floor', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { strategy: 'access_tokens', guard: 'api' },
      minRequestMs: 150,
    })
    const guard = {
      strategy: 'access_tokens' as const,
      name: 'api',
      establish: async () => 'token',
      terminate: async () => {},
    }
    for (const [index, email] of ['missing@example.test', user.email].entries()) {
      const started = performance.now()
      await assert.rejects(
        () =>
          account.authentication.login(
            { email, password: 'wrong', clientKey: `floor-${index}` },
            guard
          ),
        'Invalid email or password'
      )
      assert.isAtLeast(performance.now() - started, 150)
    }
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
      'Email verification is required'
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
