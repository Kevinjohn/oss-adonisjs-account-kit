import type { AccountKitConfig } from '../../src/types.js'
import type { TestApp } from './app.js'
import { makeService } from './account_kit_service.js'
import { insertUser } from './insert_user.js'

/** The user and service helpers the email-verification specs share, bound to one test app. */
export function verificationHelpers(kit: TestApp) {
  const createUser = async (verified = false) => {
    const user = await insertUser(kit, { verified })
    return user.id
  }

  const service = (overrides: Partial<AccountKitConfig> = {}) => makeService(kit, overrides)

  return { createUser, service }
}
