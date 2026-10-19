import { test } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import { useTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'

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
