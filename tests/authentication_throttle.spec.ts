import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { makeUsersAdapter } from './helpers/users_adapter.js'

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

  test('the client budget counts failures across identities and success consumes no budget', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { strategy: 'session', guard: 'web' },
      minRequestMs: 0,
    })
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
    const { account } = makeService(kit, {
      authentication: { strategy: 'session', guard: 'web' },
      minRequestMs: 0,
    })
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

  test('parallel guesses against one identity check at most the identity budget', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const users = makeUsersAdapter(kit.db, kit.hash)
    let checks = 0
    const { account } = makeService(kit, {
      users: {
        ...users,
        verifyPassword: async (...args) => {
          checks++
          return users.verifyPassword(...args)
        },
      },
      authentication: { strategy: 'session', guard: 'web' },
      minRequestMs: 0,
    })
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        account.authentication.login(
          { email: user.email, password: 'wrong', clientKey: 'burst' },
          sessionGuard()
        )
      )
    )
    assert.isTrue(attempts.every((result) => result.status === 'rejected'))
    assert.isAtMost(checks, 5)
  })

  test('a burst of correct logins on one client leaves no budget spent', async ({ assert }) => {
    const users = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        insertUser(kit, { email: `office-${index}@example.test` })
      )
    )
    const { account } = makeService(kit, {
      authentication: { strategy: 'session', guard: 'web' },
      minRequestMs: 0,
    })
    const attempts = await Promise.allSettled(
      users.map((user) =>
        account.authentication.login(
          { email: user.email, password: 'password123', clientKey: 'office' },
          sessionGuard()
        )
      )
    )
    assert.isTrue(attempts.some((result) => result.status === 'rejected'))
    for (const user of users) {
      await account.authentication.login(
        { email: user.email, password: 'password123', clientKey: 'office' },
        sessionGuard()
      )
    }
  })

  test('failures unrelated to the credentials spend no login budget', async ({ assert }) => {
    const user = await insertUser(kit)
    const users = makeUsersAdapter(kit.db, kit.hash)
    let outage = true
    const { account } = makeService(kit, {
      users: {
        ...users,
        verifyPassword: async (...args) => {
          if (outage) throw new Error('database offline')
          return users.verifyPassword(...args)
        },
      },
      authentication: { strategy: 'session', guard: 'web' },
      minRequestMs: 0,
    })
    for (let attempt = 0; attempt < 12; attempt++) {
      await assert.rejects(
        () =>
          account.authentication.login(
            { email: user.email, password: 'password123', clientKey: 'outage' },
            sessionGuard()
          ),
        'database offline'
      )
    }
    outage = false
    const { account: signedIn } = await account.authentication.login(
      { email: user.email, password: 'password123', clientKey: 'outage' },
      sessionGuard()
    )
    assert.equal(signedIn.id, user.id)
  })
})
