import { test } from '@japa/runner'
import {
  E_ACCOUNT_KIT_DELIVERY,
  E_ACCOUNT_KIT_POST_COMMIT,
  E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID,
} from '../src/errors.js'
import { useTestApp } from './helpers/app.js'
import { makeService, makeUsersAdapter } from './helpers/fakes.js'
import { clientChallenge, provider } from './helpers/social_identity.js'

test.group('social registration follow-ups', (group) => {
  const kit = useTestApp(group)

  for (const entry of ['callback', 'continuation'] as const) {
    for (const stage of ['lookup', 'delivery'] as const) {
      test(`${entry}: activation ${stage} failure preserves signup commit meaning`, async ({
        assert,
      }) => {
        const failure = new Error('Activation lookup unavailable')
        const users = makeUsersAdapter(kit.db, kit.hash)
        const { account, recorder } = makeService(kit, {
          users: {
            ...users,
            async findById(id, trx) {
              if (!trx && stage === 'lookup') throw failure
              return users.findById(id, trx)
            },
          },
          enabled: ['socialAuthentication', 'emailVerification'],
          registration: {
            availability: 'open',
            ...(entry === 'continuation' ? { mapFields: () => ({}) } : {}),
          },
          authentication: { strategy: 'session', guard: 'web' },
          socialAuthentication: {
            providers: { github: provider('signup-subject', 'signup@example.test', false) },
          },
        })
        if (stage === 'delivery') recorder.failOn('accountActivationProvision')
        const start = await account.socialAuthentication.begin({
          provider: 'github',
          intent: 'login',
          clientChallenge,
        })
        let signup = () =>
          account.socialAuthentication.callback({ state: start.state, callback: {} })
        if (entry === 'continuation') {
          const pending = await signup()
          if (!('continuation' in pending) || !pending.continuation)
            throw new Error('Missing registration continuation')
          const continuation = pending.continuation
          signup = () => account.socialAuthentication.completeRegistration({ continuation })
        }
        const thrown = await signup().catch((error) => error)
        if (stage === 'lookup') {
          assert.instanceOf(thrown, E_ACCOUNT_KIT_POST_COMMIT)
          assert.strictEqual(thrown.cause, failure)
        } else {
          assert.instanceOf(thrown, E_ACCOUNT_KIT_DELIVERY)
        }
        assert.lengthOf(await kit.db.from('users').where('email', 'signup@example.test'), 1)
        assert.lengthOf(await kit.db.from('social_identities').whereNull('confirmed_at'), 1)
        assert.lengthOf(await kit.db.from('social_transactions'), 0)
        assert.lengthOf(await kit.db.from('email_verification_tokens'), stage === 'lookup' ? 0 : 1)
        await assert.rejects(signup, E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID)
      })
    }
  }
})
