import type { AccountKit } from '../../src/account_kit.js'
import type { AccountKitConfig, AccountUser } from '../../src/types.js'
import type { TestApp } from './app.js'
import { tokenFrom } from './account_kit_config.js'
import { insertUser } from './insert_user.js'
import type { makeNotify } from './notifications.js'
import { makeService } from './account_kit_service.js'

/** The actor, service and issue helpers the invitation specs share, bound to one test app. */
export function invitationHelpers(kit: TestApp) {
  const createActor = (email = 'actor@example.test') => insertUser(kit, { email })

  const service = (overrides: Partial<AccountKitConfig> = {}) => makeService(kit, overrides)

  async function issue(
    account: AccountKit,
    recorder: ReturnType<typeof makeNotify>,
    actorId: AccountUser['id'],
    email = 'person@example.test',
    role = 'admin'
  ) {
    const invitation = await account.invitations.send({ actorId, email, role })
    const token = tokenFrom(recorder.calls.at(-1)!.args[1])
    return { invitation, token }
  }

  return { createActor, service, issue }
}
