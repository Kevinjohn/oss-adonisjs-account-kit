import { AccountKit } from '../../src/account_kit.ts'
import { resolveConfig as defineConfig } from '../../src/config.ts'
import type { AccountKitConfig } from '../../src/types.ts'
import type { TestApp } from './app.ts'
import { makeConfig } from './account_kit_config.ts'
import { makeNotify } from './notifications.ts'
import { makeUsersAdapter } from './users_adapter.ts'

export const accountKit = (kit: TestApp, config: ReturnType<typeof defineConfig>) =>
  new AccountKit({ config, db: kit.db, limiter: kit.limiter })

/** A service over the database adapter with its own notification recorder. */
export function makeService(kit: TestApp, overrides: Partial<AccountKitConfig> = {}) {
  const recorder = makeNotify()
  const { users = makeUsersAdapter(kit.db, kit.hash), ...rest } = overrides
  const config = defineConfig(makeConfig({ users, notify: recorder.notify, ...rest }))
  return { account: accountKit(kit, config), recorder, config, users }
}
