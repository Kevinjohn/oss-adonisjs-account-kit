import { test } from '@japa/runner'
import { bootTestApp } from './helpers/app.js'
import { resetSchema } from './helpers/schema.js'
import { makeService, makeUsersAdapter } from './helpers/fakes.js'
import { clientChallenge, provider } from './helpers/social_identity.js'
import { SocialTransactionError } from '../src/errors.js'
import { isUserEmailUniqueViolation } from '../src/db.js'

test.group('social registration email collisions', () => {
  for (const entry of ['callback', 'continuation', 'verification hook'] as const) {
    test(`${entry}: a duplicate email rolls back signup with the appropriate result`, async ({
      assert,
    }) => {
      const kit = await bootTestApp()
      try {
        await resetSchema(kit)
        const users = makeUsersAdapter(kit.db, kit.hash)
        let insertFailure: unknown
        const duplicate = async (...args: Parameters<typeof users.create>) => {
          try {
            return await users.create(...args)
          } catch (error) {
            insertFailure = error
            throw error
          }
        }
        const { account, config, recorder } = makeService(kit, {
          users: {
            ...users,
            async create(attrs, trx) {
              // Stage the collision after the lookup, using the real users email index.
              const user = await users.create(attrs, trx)
              return entry === 'verification hook' ? user : duplicate(attrs, trx)
            },
            async markEmailVerified(id, verifiedAt, trx) {
              if (entry === 'verification hook') {
                await duplicate(
                  { email: 'duplicate@example.test', unverifiedEmail: null, password: null },
                  trx
                )
              }
              await users.markEmailVerified(id, verifiedAt, trx)
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
        const runCallback = () =>
          account.socialAuthentication.callback({ state: start.state, callback: {} })
        if (entry === 'verification hook') {
          const error = await runCallback().catch((caught: unknown) => caught)
          assert.instanceOf(error, SocialTransactionError)
        } else {
          const callback = await runCallback()
          if (entry === 'continuation') {
            if (!('continuation' in callback) || !callback.continuation)
              throw new Error('Missing continuation')
            const result = await account.socialAuthentication.completeRegistration({
              continuation: callback.continuation,
            })
            assert.deepEqual(result, { status: 'link_required' })
          } else {
            assert.deepEqual(callback, { status: 'link_required' })
          }
        }
        assert.isTrue(await isUserEmailUniqueViolation(insertFailure, config, kit.db))
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
