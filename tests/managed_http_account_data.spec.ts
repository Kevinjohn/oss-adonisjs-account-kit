import { test } from '@japa/runner'
import { registerManagedRoutes, type ManagedGuard } from '../src/http/managed.js'
import { planManagedRoutes } from '../src/http/routes.js'
import type { AccountKitConfig, AccountUser, CurrentAccountInput, Trx } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { fixture } from './helpers/managed_http.js'
import { seedAccountRows } from './helpers/account_rows.js'

type Validator = { validate(data: unknown): Promise<unknown> }

test.group('managed account data routes', (group) => {
  const kit = useTestApp(group)

  function mount(strategy: 'session' | 'access_tokens', overrides: Partial<AccountKitConfig> = {}) {
    const service = makeService(kit, {
      enabled: ['dataExport', 'accountDeletion'],
      authentication: { guard: strategy === 'session' ? 'web' : 'api', strategy },
      ...overrides,
    })
    const terminated: unknown[] = []
    const warnings: unknown[] = []
    let caller: CurrentAccountInput | undefined
    let failTerminate = false
    const guard = {
      strategy,
      name: strategy === 'session' ? 'web' : 'api',
      forRequest: () =>
        ({
          strategy,
          name: strategy === 'session' ? 'web' : 'api',
          establish: async () => 'credential',
          terminate: async () => {
            terminated.push('terminate')
            if (failTerminate) throw new Error('session store down')
          },
        }) as never,
      current: async () => caller!,
      publicCredential: (credential: string) => credential,
    } as ManagedGuard<string>
    const { router, routes, context } = fixture()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => service.account,
      guard,
      enabled: ['dataExport', 'accountDeletion'],
    })
    const call = async (
      key: string,
      as: CurrentAccountInput,
      body: Record<string, unknown> = { currentPassword: 'password123' },
      options: { csrf?: boolean } = {}
    ) => {
      caller = as
      const ctx = context()
      Object.assign(ctx, { logger: { warn: (...args: unknown[]) => void warnings.push(args) } })
      Object.assign(ctx.request, {
        validateUsing: (validator: Validator) => validator.validate(body),
        ...(strategy === 'session' && options.csrf !== false ? { csrfToken: 'csrf' } : {}),
      })
      const output = (await routes.get(key)!(ctx)) as { status: number; body?: any }
      return { ...output, headers: ctx.headers }
    }
    const as = (user: AccountUser): CurrentAccountInput =>
      strategy === 'session' ? { userId: user.id, revision: null } : { userId: user.id, tokenId: 0 }
    return {
      service,
      call,
      as,
      terminated,
      warnings,
      failTerminate: () => {
        failTerminate = true
      },
    }
  }

  async function withToken(user: AccountUser): Promise<CurrentAccountInput> {
    const [row] = await kit.db
      .table('auth_access_tokens')
      .insert({ tokenable_id: user.id, hash: `hash-${user.id}` })
      .returning('id')
    return { userId: user.id, tokenId: typeof row === 'object' ? row.id : row }
  }

  test('export downloads the document without caching', async ({ assert }) => {
    const user = await insertUser(kit)
    const { call, as, warnings } = mount('session')
    const output = await call('POST /api/v1/account/export', as(user))
    assert.equal(output.status, 200)
    assert.equal(output.body.format, 'adonisjs-account-kit/export')
    assert.equal(output.body.account.id, user.id)
    assert.equal(output.headers['Cache-Control'], 'no-store')
    assert.equal(
      output.headers['Content-Disposition'],
      'attachment; filename="account-export.json"'
    )
    assert.deepEqual(warnings, [])
  })

  test('a wrong password is refused without a document', async ({ assert }) => {
    const user = await insertUser(kit)
    const { call, as } = mount('session')
    const output = await call('POST /api/v1/account/export', as(user), {
      currentPassword: 'wrong-password',
    })
    assert.equal(output.status, 403)
    assert.equal(output.body.errors[0].code, 'E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED')
    assert.notProperty(output.headers, 'Content-Disposition')
  })

  test('an export fault after commit still sends the document and logs a diagnostic', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { call, as, warnings } = mount('session', {
      exportAccountData: async (_user: AccountUser, trx: Trx) => {
        trx.on('commit', () => {
          throw new Error('commit listener failed')
        })
        return { kept: true }
      },
    })
    const output = await call('POST /api/v1/account/export', as(user))
    assert.equal(output.status, 200)
    assert.deepEqual(output.body.application, { kept: true })
    assert.deepEqual(warnings, [
      [
        { operation: 'account.data.export', outcome: 'followup_failed' },
        'Managed account operation needs reconciliation',
      ],
    ])
  })

  test('session deletion answers 204 and ends the session', async ({ assert }) => {
    const user = await insertUser(kit)
    const { call, as, terminated } = mount('session')
    const output = await call('DELETE /api/v1/account', as(user))
    assert.equal(output.status, 204)
    assert.deepEqual(terminated, ['terminate'])
    assert.isNull(await kit.db.from('users').where('id', user.id).first())
    const after = await call('POST /api/v1/account/export', as(user))
    assert.equal(after.status, 401)
  })

  test('a refused deletion keeps the session', async ({ assert }) => {
    const user = await insertUser(kit)
    const { call, as, terminated } = mount('session', {
      onAccountDeletingTransaction: async () => {
        throw new Error('application refused')
      },
    })
    await assert.rejects(() => call('DELETE /api/v1/account', as(user)), /application refused/)
    const wrong = await call('DELETE /api/v1/account', as(user), {
      currentPassword: 'wrong-password',
    })
    assert.equal(wrong.status, 403)
    assert.deepEqual(terminated, [])
    assert.isNotNull(await kit.db.from('users').where('id', user.id).first())
  })

  test('a failed email or observer after deletion answers 202 and still ends the session', async ({
    assert,
  }) => {
    const first = await insertUser(kit)
    const second = await insertUser(kit, { email: 'second@example.test' })
    const delivery = mount('session')
    delivery.service.recorder.failOn('accountDeleted')
    const failedEmail = await delivery.call('DELETE /api/v1/account', delivery.as(first))
    assert.equal(failedEmail.status, 202)
    assert.deepEqual(failedEmail.body, { committed: true })
    assert.deepEqual(delivery.terminated, ['terminate'])

    const observer = mount('session', {
      onLifecycleEvent: async () => {
        throw new Error('observer down')
      },
    })
    const failedObserver = await observer.call('DELETE /api/v1/account', observer.as(second))
    assert.equal(failedObserver.status, 202)
    assert.deepEqual(observer.terminated, ['terminate'])
    assert.lengthOf(await kit.db.from('users'), 0)
  })

  test('a session that cannot be ended is logged; the deletion stands', async ({ assert }) => {
    const user = await insertUser(kit)
    const { call, as, warnings, failTerminate } = mount('session')
    failTerminate()
    const output = await call('DELETE /api/v1/account', as(user))
    assert.equal(output.status, 204)
    assert.deepEqual(warnings, [
      [
        { operation: 'account.delete', outcome: 'session_end_failed' },
        'Managed account operation needs reconciliation',
      ],
    ])
  })

  test('token deletion removes the bearer without calling terminate', async ({ assert }) => {
    const user = await insertUser(kit)
    await seedAccountRows(kit, user.id, 'a')
    const { call, terminated } = mount('access_tokens')
    const bearer = await withToken(user)
    const output = await call('DELETE /api/v1/account', bearer)
    assert.equal(output.status, 204)
    assert.deepEqual(terminated, [])
    assert.lengthOf(await kit.db.from('auth_access_tokens').where('tokenable_id', user.id), 0)
    const again = await call('POST /api/v1/account/export', bearer)
    assert.equal(again.status, 401)
  })

  test('session writes require Shield CSRF middleware', async ({ assert }) => {
    const user = await insertUser(kit)
    const { call, as } = mount('session')
    for (const key of ['POST /api/v1/account/export', 'DELETE /api/v1/account'])
      await assert.rejects(
        () => call(key, as(user), undefined, { csrf: false }),
        /require Shield CSRF middleware/
      )
    assert.isNotNull(await kit.db.from('users').where('id', user.id).first())
  })

  test('the route plan publishes export and delete as limited routes', ({ assert }) => {
    const routes = planManagedRoutes({
      prefix: '/api/v1',
      strategy: 'access_tokens',
      enabled: ['dataExport', 'accountDeletion'],
    })
    assert.deepEqual(
      routes.map(({ name, method, path, access, proof }) => [name, method, path, access, proof]),
      [
        ['account.data.export', 'POST', '/api/v1/account/export', 'limited', undefined],
        ['account.delete', 'DELETE', '/api/v1/account', 'limited', undefined],
      ]
    )
  })
})
