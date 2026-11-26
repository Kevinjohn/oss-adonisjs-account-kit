import type { AccountKit } from '../../src/account_kit.ts'
import type { AccountKitConfig, AccountUser } from '../../src/types.ts'
import type { TestApp } from './app.ts'
import { tokenFrom } from './account_kit_config.ts'
import { insertUser } from './insert_user.ts'
import type { makeNotify } from './notifications.ts'
import { makeService } from './account_kit_service.ts'

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
