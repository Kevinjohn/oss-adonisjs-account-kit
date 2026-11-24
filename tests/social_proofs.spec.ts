import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService, makeUsersAdapter } from './helpers/fakes.js'
import {
  E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED,
  E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID,
  E_ACCOUNT_KIT_THROTTLED,
} from '../src/errors.js'
import { current, provider } from './helpers/social_identity.js'
import type { UserId } from '../src/types.js'

test.group('social password proof budget', (group) => {
  const kit = useTestApp(group)

  const service = () => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const verified: unknown[] = []
    const verifyPassword = users.verifyPassword.bind(users)
    users.verifyPassword = async (id, password, trx) => {
      verified.push(id)
      return verifyPassword(id, password, trx)
    }
    const { account } = makeService(kit, {
      users,
      enabled: ['socialAuthentication', 'emailVerification', 'emailPasswordManagement'],
      socialAuthentication: {
        providers: { google: provider('budget', 'budget@example.test', true) },
      },
      authentication: { strategy: 'session', guard: 'web' },
      throttle: { requests: 1, duration: '1m' },
    })
    return { account, verified }
  }

  test('rejects with E_ACCOUNT_KIT_THROTTLED once the account budget is spent, without checking the password', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account, verified } = service()
    const prove = () =>
      account.socialAuthentication.provePassword({
        current: current(user.id),
        password: 'wrong-password',
        purpose: 'social_link',
      })
    await assert.rejects(prove, E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID)
    assert.lengthOf(verified, 1)
    await assert.rejects(prove, E_ACCOUNT_KIT_THROTTLED)
    assert.lengthOf(verified, 1)
  })

  test('shares the account budget with password change, in both directions', async ({ assert }) => {
    const { account, verified } = service()
    const changePassword = (actorId: UserId) =>
      account.emailPasswordManagement.changePassword({
        actorId,
        currentPassword: 'wrong-password',
        newPassword: 'newPassword123',
      })
    const provePassword = (userId: UserId) =>
      account.socialAuthentication.provePassword({
        current: current(userId),
        password: 'password123',
        purpose: 'social_link',
      })

    const first = await insertUser(kit, { email: 'first@example.test' })
    await assert.rejects(() => changePassword(first.id), E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED)
    const afterChange = verified.length
    await assert.rejects(() => provePassword(first.id), E_ACCOUNT_KIT_THROTTLED)
    assert.lengthOf(verified, afterChange)

    const second = await insertUser(kit, { email: 'second@example.test' })
    assert.isString(await provePassword(second.id))
    await assert.rejects(() => changePassword(second.id), E_ACCOUNT_KIT_THROTTLED)
  })
})
