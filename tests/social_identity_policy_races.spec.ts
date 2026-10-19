import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { clientChallenge, provider, current } from './helpers/social_identity.js'
import { dbTime } from './helpers/db_time.js'

test.group('social policy and method races', (group) => {
  const kit = useTestApp(group)

  test('closed registration rejects a new subject but keeps a confirmed linked subject usable', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const adapters = { google: provider('known-subject', user.email, true) }
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'closed' },
      socialAuthentication: { providers: adapters },
      authentication: { strategy: 'session', guard: 'web' },
    })
    await kit.db.table('social_identities').insert({
      user_id: user.id,
      provider: 'google',
      provider_user_id: 'known-subject',
      email: user.email,
      email_verified: true,
      confirmed_at: dbTime(kit),
      created_at: dbTime(kit),
      updated_at: dbTime(kit),
    })
    const known = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const linked = await account.socialAuthentication.callback({ state: known.state, callback: {} })
    assert.equal(linked.status, 'linked')
    adapters.google = provider('new-subject', 'new@example.test', true)
    const fresh = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    await assert.rejects(
      () => account.socialAuthentication.callback({ state: fresh.state, callback: {} }),
      'Invalid social transaction'
    )
    assert.lengthOf(await kit.db.from('users'), 1)
  })

  test('parallel unlink cannot remove both confirmed methods from a passwordless account', async ({
    assert,
  }) => {
    const user = await insertUser(kit, { password: null })
    const timestamp = dbTime(kit)
    for (const [providerName, subject] of [
      ['google', 'g-subject'],
      ['github', 'h-subject'],
    ] as const) {
      await kit.db.table('social_identities').insert({
        user_id: user.id,
        provider: providerName,
        provider_user_id: subject,
        email: user.email,
        email_verified: true,
        confirmed_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      })
    }
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'closed' },
      socialAuthentication: {
        providers: {
          google: provider('g-subject', user.email, true),
          github: provider('h-subject', user.email, true),
        },
      },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const first = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'reauth',
      current: current(user.id),
      purpose: 'social_unlink',
      clientChallenge,
    })
    const second = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'reauth',
      current: current(user.id),
      purpose: 'social_unlink',
      clientChallenge,
    })
    const firstProof = await account.socialAuthentication.callback({
      state: first.state,
      callback: {},
      current: current(user.id),
    })
    const secondProof = await account.socialAuthentication.callback({
      state: second.state,
      callback: {},
      current: current(user.id),
    })
    if (firstProof.status !== 'reauthenticated' || secondProof.status !== 'reauthenticated')
      throw new Error('Expected proofs')
    const rows = await account.socialAuthentication.list({ current: current(user.id) })
    const outcomes = await Promise.allSettled([
      account.socialAuthentication.unlink({
        current: current(user.id),
        identityId: rows[0].id,
        proof: firstProof.proof,
      }),
      account.socialAuthentication.unlink({
        current: current(user.id),
        identityId: rows[1].id,
        proof: secondProof.proof,
      }),
    ])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    assert.lengthOf(await kit.db.from('social_identities').where('user_id', user.id), 1)
  })
})
