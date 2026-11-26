import { test } from '@japa/runner'
import { resolveConfig as defineConfig } from '../src/config.ts'
import type { AccountKitConfig } from '../src/types.ts'
import { useTestApp } from './helpers/app.ts'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.ts'

test.group('session management config', (group) => {
  const kit = useTestApp(group)
  const base = (overrides: Partial<AccountKitConfig> = {}) =>
    makeConfig({
      users: makeUsersAdapter(kit.db, kit.hash),
      enabled: ['sessionManagement'],
      authentication: { strategy: 'session', guard: 'web' },
      ...overrides,
    })

  test('idle expiry defaults to 30 days and must exceed the five-minute touch interval', ({
    assert,
  }) => {
    assert.deepEqual(defineConfig(base()).sessionManagement, { idleExpiry: '30d' })
    for (const idleExpiry of ['6m', 301, '1h'])
      assert.deepEqual(
        defineConfig(base({ sessionManagement: { idleExpiry } })).sessionManagement,
        {
          idleExpiry,
        }
      )
    for (const idleExpiry of ['5m', 300, '1m'])
      assert.throws(
        () => defineConfig(base({ sessionManagement: { idleExpiry } })),
        /idleExpiry must be longer than 5 minutes/
      )
    assert.throws(() => defineConfig(base({ sessionManagement: { idleExpiry: 'soon' } })))
    assert.throws(
      () => defineConfig(base({ sessionManagement: [] as never })),
      /sessionManagement must be an object/
    )
    assert.throws(
      () => defineConfig(base({ authentication: undefined })),
      /sessionManagement requires authentication/
    )
    assert.notInclude(defineConfig(base({ enabled: undefined })).enabled, 'sessionManagement')
  })
})
