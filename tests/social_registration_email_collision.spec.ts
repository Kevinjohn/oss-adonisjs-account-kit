import { test } from '@japa/runner'
import { bootTestApp } from './helpers/app.js'
import { resetSchema } from './helpers/schema.js'
import { makeService, makeUsersAdapter } from './helpers/fakes.js'
import { clientChallenge, provider } from './helpers/social_identity.js'
import { isUserEmailUniqueViolation } from '../src/db.js'

test.group('social registration email collisions', () => {
  for (const entry of ['callback', 'continuation'] as const) {
    test(`${entry}: a duplicate email at insertion returns link_required and rolls back`, async ({
      assert,
    }) => {
      const kit = await bootTestApp()
      try {
        await resetSchema(kit)
        const users = makeUsersAdapter(kit.db, kit.hash)
        let insertFailure: unknown
        const { account, config, recorder } = makeService(kit, {
          users: {
            ...users,
            async create(attrs, trx) {
              // Stage the collision after the lookup, using the real users email index.
              await users.create(attrs, trx)
              try {
                return await users.create(attrs, trx)
              } catch (error) {
                insertFailure = error
                throw error
              }
            },
          },
          enabled: ['socialAuthentication', 'emailVerification'],
          registration: {
            availability: 'open',
            ...(entry === 'continuation' ? { mapFields: () => ({}) } : {}),
          },
          authentication: { strategy: 'session', guard: 'web' },
          socialAuthentication: {
            providers: { github: provider('duplicate-subject', 'duplicate@example.test', true) },
          },
        })
        const start = await account.socialAuthentication.begin({
          provider: 'github',
          intent: 'login',
          clientChallenge,
        })
        const callback = await account.socialAuthentication.callback({
          state: start.state,
          callback: {},
        })
        let result = callback
        if (entry === 'continuation') {
          if (!('continuation' in callback) || !callback.continuation)
            throw new Error('Missing continuation')
          result = await account.socialAuthentication.completeRegistration({
            continuation: callback.continuation,
          })
        }
        assert.isTrue(await isUserEmailUniqueViolation(insertFailure, config, kit.db))
        assert.deepEqual(result, { status: 'link_required' })
        assert.lengthOf(await kit.db.from('users'), 0)
        assert.lengthOf(await kit.db.from('social_identities'), 0)
        assert.lengthOf(await kit.db.from('social_handoff_codes'), 0)
        assert.lengthOf(recorder.calls, 0)
      } finally {
        await kit.close()
      }
    })
  }
})
