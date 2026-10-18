import { DateTime } from 'luxon'
import type { AccountKit } from '../../src/account_kit.js'
import { generateToken, hashToken } from '../../src/tokens.js'
import type { AccountKitConfig, AccountUser } from '../../src/types.js'
import type { TestApp } from './app.js'
import { insertUser, type makeNotify, makeService, tokenFrom } from './fakes.js'
import { dbTime } from './db_time.js'

/** Fixtures shared by the email, password and profile management specs. */
export function credentialsFixtures(kit: TestApp) {
  const createUser = (social = false) =>
    insertUser(kit, social ? { password: null, verified: false } : { password: 'oldPassword123' })

  const service = (overrides: Partial<AccountKitConfig> = {}) =>
    makeService(kit, { minRequestMs: 0, ...overrides }).account

  async function seedTokens(user: AccountUser) {
    const now = DateTime.utc()
    const recoveryToken = generateToken()
    const emailToken = generateToken()
    await kit.db.table('password_reset_tokens').insert({
      tokenable_id: user.id,
      email: user.email,
      hash: hashToken(recoveryToken),
      expires_at: dbTime(kit, now.plus({ hours: 1 })),
      created_at: dbTime(kit, now),
    })
    await kit.db.table('email_verification_tokens').insert({
      tokenable_id: user.id,
      email: 'next@example.test',
      hash: hashToken(emailToken),
      expires_at: dbTime(kit, now.plus({ hours: 1 })),
      created_at: dbTime(kit, now),
    })
    return recoveryToken
  }

  async function issueEmailChange(
    account: AccountKit,
    user: AccountUser,
    recorder: ReturnType<typeof makeNotify>,
    newEmail = 'new@example.test'
  ) {
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newEmail,
    })
    const call = recorder.calls.at(-1)!
    assertEmailChangeCall(call, user, newEmail)
    return tokenFrom(call.args[2])
  }

  function assertEmailChangeCall(
    call: ReturnType<typeof makeNotify>['calls'][number],
    user: AccountUser,
    email: string
  ) {
    if (
      call.method !== 'emailChangeProvision' ||
      (call.args[0] as AccountUser).id !== user.id ||
      call.args[1] !== email
    )
      throw new Error('Unexpected email-change notification')
  }

  return { createUser, service, seedTokens, issueEmailChange, assertEmailChangeCall }
}
