import { test } from '@japa/runner'
import { resolveConfig as defineConfig } from '../src/config.ts'
import { useTestApp } from './helpers/app.ts'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.ts'

test.group('password policy configuration', (group) => {
  const kit = useTestApp(group)

  test('rejects contradictory password-policy configuration', ({ assert }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    for (const passwordPolicy of [
      { minLength: 257 },
      { maxLength: 257 },
      { minLength: 12, maxLength: 11 },
      { minScore: 5 as never },
      { symbols: 'yes' as never },
    ]) {
      assert.throws(() => defineConfig(makeConfig({ users, passwordPolicy })))
    }
  })
})
