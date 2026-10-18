import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { clientChallenge, provider } from './helpers/social_identity.js'

test.group('social identity services', (group) => {
  const kit = useTestApp(group)

  test('resolves an existing provider subject even after its email changes', async ({ assert }) => {
    const adapters = { google: provider('subject-1', 'first@example.test', true) }
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      socialAuthentication: { providers: adapters },
      registration: { availability: 'open' },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const first = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const created = await account.socialAuthentication.callback({
      state: first.state,
      callback: {},
    })
    assert.equal(created.status, 'new')
    if (created.status !== 'new' || !('userId' in created))
      throw new Error('Expected a newly created account')
    adapters.google = provider('subject-1', 'changed@example.test', true)
    const again = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const linked = await account.socialAuthentication.callback({ state: again.state, callback: {} })
    assert.equal(linked.status, 'linked')
    if (linked.status !== 'linked') throw new Error('Expected linked account')
    assert.equal(linked.userId, created.userId)
    const user = await kit.db.from('users').where('id', created.userId).first()
    assert.equal(user.email, 'first@example.test')
  })

  test('does not merge a verified provider email with an existing local account', async ({
    assert,
  }) => {
    const local = await insertUser(kit)
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      socialAuthentication: {
        providers: { google: provider('subject-2', local.email, true) },
      },
      registration: { availability: 'open' },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const start = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const result = await account.socialAuthentication.callback({ state: start.state, callback: {} })
    assert.equal(result.status, 'link_required')
    if (result.status !== 'link_required') throw new Error('Expected linking continuation')
    assert.isFalse('userId' in result)
    assert.lengthOf(await kit.db.from('social_identities'), 0)
  })

  test('consumes the callback state once and rejects an intent swap', async ({ assert }) => {
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      socialAuthentication: {
        providers: { google: provider('subject-3', 'new@example.test', true) },
      },
      registration: { availability: 'open' },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const start = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    await assert.rejects(
      () =>
        account.socialAuthentication.callback({
          state: start.state,
          provider: 'github',
          callback: {},
        }),
      'Invalid social transaction'
    )
    await assert.rejects(
      () =>
        account.socialAuthentication.callback({ state: start.state, callback: {}, intent: 'link' }),
      'Invalid social transaction'
    )
    await account.socialAuthentication.callback({ state: start.state, callback: {} })
    await assert.rejects(
      () => account.socialAuthentication.callback({ state: start.state, callback: {} }),
      'Invalid social transaction'
    )
  })
})
