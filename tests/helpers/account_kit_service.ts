import { AccountKit, defineConfig } from '../../src/account_kit.js'
import type { AccountKitConfig } from '../../src/types.js'
import type { TestApp } from './app.js'
import { makeConfig } from './account_kit_config.js'
import { makeNotify } from './notifications.js'
import { makeUsersAdapter } from './users_adapter.js'

export const accountKit = (kit: TestApp, config: ReturnType<typeof defineConfig>) =>
  new AccountKit({ config, db: kit.db, limiter: kit.limiter })

/** A service over the database adapter with its own notification recorder. */
export function makeService(kit: TestApp, overrides: Partial<AccountKitConfig> = {}) {
  const recorder = makeNotify()
  const { users = makeUsersAdapter(kit.db, kit.hash), ...rest } = overrides
  const config = defineConfig(makeConfig({ users, notify: recorder.notify, ...rest }))
  return { account: accountKit(kit, config), recorder, config, users }
}
