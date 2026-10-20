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

  for (const {} of ['session', 'access_tokens'] as const) {
  }
})
