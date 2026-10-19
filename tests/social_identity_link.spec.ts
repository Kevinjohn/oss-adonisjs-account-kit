import { test } from '@japa/runner'
import { advanceCredentialRevision } from '../src/authentication.js'
import { transaction } from '../src/db.js'
import { consumeSocialSensitiveProof } from '../src/social_identity.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { clientChallenge, current, provider } from './helpers/social_identity.js'

test.group('social link and proof binding atomicity', (group) => {
  const kit = useTestApp(group)

  test('links only after password re-entry and a callback bound to the same actor', async ({
    assert,
  }) => {
    const first = await insertUser(kit)
    const second = await insertUser(kit, { email: 'second@example.test' })
    const { account, recorder } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: {
        providers: { google: provider('linked-subject', first.email, false) },
      },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const state = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'link',
      clientChallenge,
      current: current(first.id),
    })
    const proof = await account.socialAuthentication.provePassword({
      current: current(first.id),
      password: 'password123',
      purpose: 'social_link',
    })
    await assert.rejects(
      () =>
        account.socialAuthentication.callback({
          state: state.state,
          callback: {},
          current: current(second.id),
          proof,
        }),
      'Invalid social transaction'
    )
    const linked = await account.socialAuthentication.callback({
      state: state.state,
      callback: {},
      current: current(first.id),
      proof,
    })
    assert.equal(linked.status, 'linked')
    assert.lengthOf(await kit.db.from('social_identities'), 1)
    assert.equal(recorder.calls.filter((call) => call.method === 'socialIdentityLinked').length, 1)
    const duplicate = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'link',
      clientChallenge,
      current: current(second.id),
    })
    const secondProof = await account.socialAuthentication.provePassword({
      current: current(second.id),
      password: 'password123',
      purpose: 'social_link',
    })
    await assert.rejects(
      () =>
        account.socialAuthentication.callback({
          state: duplicate.state,
          callback: {},
          current: current(second.id),
          proof: secondProof,
        }),
      'Social identity is already linked'
    )
    assert.lengthOf(await kit.db.from('social_identities'), 1)
  })

  test('keeps a link proof bound to state without exposing it to the provider callback', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: { providers: { google: provider('state-proof-subject', null, false) } },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const proof = await account.socialAuthentication.provePassword({
      current: current(user.id),
      password: 'password123',
      purpose: 'social_link',
    })
    const started = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'link',
      current: current(user.id),
      clientChallenge,
      proof,
    })
    assert.notInclude(started.url, proof)
    const result = await account.socialAuthentication.callback({
      state: started.state,
      callback: {},
      current: current(user.id),
    })
    assert.equal(result.status, 'linked')
    assert.lengthOf(await kit.db.from('social_sensitive_proofs'), 0)
  })

  test('rejects a recent proof after its credential revision changes', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account, config } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: { providers: { google: provider('revision-subject', null, false) } },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const proof = await account.socialAuthentication.provePassword({
      current: current(user.id),
      password: 'password123',
      purpose: 'social_unlink',
    })
    await transaction(kit.db, (trx) => advanceCredentialRevision(trx, config, user.id))
    await assert.rejects(
      () =>
        transaction(kit.db, (trx) =>
          consumeSocialSensitiveProof(trx, config, user.id, 'social_unlink', proof)
        ),
      'Invalid recent authentication proof'
    )
  })

  test('rejects proof replay and wrong purpose, then preserves a password login on unlink', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: { providers: { google: provider('unlink-subject', null, false) } },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const wrong = await account.socialAuthentication.provePassword({
      current: current(user.id),
      password: 'password123',
      purpose: 'social_unlink',
    })
    const state = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'link',
      clientChallenge,
      current: current(user.id),
    })
    await assert.rejects(
      () =>
        account.socialAuthentication.callback({
          state: state.state,
          callback: {},
          current: current(user.id),
          proof: wrong,
        }),
      'Invalid recent authentication proof'
    )
    const linkProof = await account.socialAuthentication.provePassword({
      current: current(user.id),
      password: 'password123',
      purpose: 'social_link',
    })
    await account.socialAuthentication.callback({
      state: state.state,
      callback: {},
      current: current(user.id),
      proof: linkProof,
    })
    const identities = await account.socialAuthentication.list({ current: current(user.id) })
    const identity = identities[0]
    await account.socialAuthentication.unlink({
      current: current(user.id),
      identityId: identity.id,
      proof: wrong,
    })
    // The unlink advanced the credential revision, so the session that performed it is over.
    await assert.rejects(
      () =>
        account.socialAuthentication.unlink({
          current: current(user.id),
          identityId: identity.id,
          proof: wrong,
        }),
      'Invalid session'
    )
    assert.lengthOf(await kit.db.from('social_identities'), 0)
  })

  test('quarantines unverified bootstrap identity and removes it on email claim', async ({
    assert,
  }) => {
    const adapters = { github: provider('attacker-subject', 'victim@example.test', false) }
    const { account, recorder } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: { providers: adapters },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const start = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'login',
      clientChallenge,
    })
    const created = await account.socialAuthentication.callback({
      state: start.state,
      callback: {},
    })
    assert.equal(created.status, 'new')
    const pending = await kit.db.from('social_identities').first()
    assert.isNull(pending.confirmed_at)
    const retry = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'login',
      clientChallenge,
    })
    await assert.rejects(
      () => account.socialAuthentication.callback({ state: retry.state, callback: {} }),
      'Social account was not found'
    )
    const sent = recorder.calls.find((call) => call.method === 'accountActivationProvision')
    if (!sent) throw new Error('Expected activation proof')
    const token = new URL(sent.args[1] as string).pathname.split('/').at(-1)!
    await account.emailVerification.complete({ token, password: 'New-Owner-Password-9!' })
    assert.lengthOf(await kit.db.from('social_identities'), 0)
    const afterClaim = await account.socialAuthentication.callback({
      state: retry.state,
      callback: {},
    })
    assert.deepEqual(afterClaim, { status: 'link_required' })
  })
})
