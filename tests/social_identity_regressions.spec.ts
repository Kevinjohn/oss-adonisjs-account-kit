import { test } from '@japa/runner'
import { advanceCredentialRevision } from '../src/authentication.js'
import { transaction } from '../src/db.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { verifier, clientChallenge, provider } from './helpers/social_identity.js'
import { dbTime } from './helpers/db_time.js'

test.group('social association and continuation regressions', (group) => {
  const kit = useTestApp(group)
  const current = (userId: number | string) => ({ userId, revision: null })
  const sessionGuard = {
    strategy: 'session' as const,
    name: 'web',
    establish: async () => 'session',
    terminate: async () => {},
  }

  test('an unlinked association cannot redeem its earlier handoff', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: {
        providers: { google: provider('unlinked-handoff', user.email, true) },
      },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const proof = await account.socialAuthentication.provePassword({
      current: current(user.id),
      password: 'password123',
      purpose: 'social_link',
    })
    const linking = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'link',
      current: current(user.id),
      clientChallenge,
      proof,
    })
    await account.socialAuthentication.callback({
      state: linking.state,
      callback: {},
      current: current(user.id),
    })
    const login = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const handoff = await account.socialAuthentication.callback({
      state: login.state,
      callback: {},
    })
    if (handoff.status !== 'linked') throw new Error('Expected linked login')
    const unlinkProof = await account.socialAuthentication.provePassword({
      current: current(user.id),
      password: 'password123',
      purpose: 'social_unlink',
    })
    const [relation] = await account.socialAuthentication.list({ current: current(user.id) })
    await account.socialAuthentication.unlink({
      current: current(user.id),
      identityId: relation.id,
      proof: unlinkProof,
    })
    await assert.rejects(
      () =>
        account.socialAuthentication.redeemHandoff({
          code: handoff.handoffCode!,
          verifier,
          guard: sessionGuard,
        }),
      'Invalid social transaction'
    )
  })

  test('unlink during handoff credential issuance terminates the provisional credential', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: { providers: { google: provider('issuance-race', user.email, true) } },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const linkProof = await account.socialAuthentication.provePassword({
      current: current(user.id),
      password: 'password123',
      purpose: 'social_link',
    })
    const linking = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'link',
      current: current(user.id),
      clientChallenge,
      proof: linkProof,
    })
    await account.socialAuthentication.callback({
      state: linking.state,
      callback: {},
      current: current(user.id),
    })
    const login = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const handoff = await account.socialAuthentication.callback({
      state: login.state,
      callback: {},
    })
    if (handoff.status !== 'linked') throw new Error('Expected linked handoff')
    const unlinkProof = await account.socialAuthentication.provePassword({
      current: current(user.id),
      password: 'password123',
      purpose: 'social_unlink',
    })
    const relations = await account.socialAuthentication.list({ current: current(user.id) })
    let terminated = 0
    const guard = {
      strategy: 'session' as const,
      name: 'web',
      establish: async () => {
        await account.socialAuthentication.unlink({
          current: current(user.id),
          identityId: relations[0].id,
          proof: unlinkProof,
        })
        return 'provisional'
      },
      terminate: async () => {
        terminated++
      },
    }
    await assert.rejects(
      () =>
        account.socialAuthentication.redeemHandoff({
          code: handoff.handoffCode!,
          verifier,
          guard,
        }),
      'Invalid social transaction'
    )
    assert.equal(terminated, 1)
  })

  test('credential revision invalidates an already issued handoff', async ({ assert }) => {
    const { account, config } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: {
        providers: { google: provider('revised-handoff', 'revised@example.test', true) },
      },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const begin = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const handoff = await account.socialAuthentication.callback({
      state: begin.state,
      callback: {},
    })
    if (handoff.status !== 'new' || !('userId' in handoff) || !handoff.handoffCode)
      throw new Error('Expected new account handoff')
    await transaction(kit.db, (trx) => advanceCredentialRevision(trx, config, handoff.userId))
    await assert.rejects(
      () =>
        account.socialAuthentication.redeemHandoff({
          code: handoff.handoffCode!,
          verifier,
          guard: sessionGuard,
        }),
      'Invalid social transaction'
    )
    assert.lengthOf(await kit.db.from('social_identities'), 1)
  })

  test('inventory excludes pending associations and collected existing email requires linking', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    await kit.db.table('social_identities').insert({
      user_id: user.id,
      provider: 'google',
      provider_user_id: 'quarantined-inventory',
      email_verified: false,
      created_at: dbTime(kit),
      updated_at: dbTime(kit),
    })
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: { providers: { github: provider('no-email', null, false) } },
      authentication: { strategy: 'session', guard: 'web' },
    })
    assert.lengthOf(await account.socialAuthentication.list({ current: current(user.id) }), 0)
    const started = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'login',
      clientChallenge,
    })
    const pending = await account.socialAuthentication.callback({
      state: started.state,
      callback: {},
    })
    if (pending.status !== 'new' || !('continuation' in pending))
      throw new Error('Expected continuation')
    const result = await account.socialAuthentication.completeRegistration({
      continuation: pending.continuation,
      email: user.email,
    })
    assert.deepEqual(result, { status: 'link_required' })
    assert.lengthOf(await kit.db.from('users'), 1)
  })

  test('wrong provider subject cannot complete joint email confirmation', async ({ assert }) => {
    const adapter = { google: provider('first-subject', 'pending@example.test', false) }
    const { account, recorder } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: { providers: adapter },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const start = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    await account.socialAuthentication.callback({ state: start.state, callback: {} })
    const sent = recorder.calls.find((call) => call.method === 'accountActivationProvision')
    if (!sent) throw new Error('Expected verification')
    const verificationToken = new URL(sent.args[1] as string).pathname.split('/').at(-1)!
    const confirm = await account.socialAuthentication.beginConfirmation({
      provider: 'google',
      verificationToken,
      clientChallenge,
    })
    adapter.google = provider('wrong-subject', 'pending@example.test', false)
    await assert.rejects(
      () => account.socialAuthentication.callback({ state: confirm.state, callback: {} }),
      'Invalid social transaction'
    )
    const pendingRelation = await kit.db.from('social_identities').first()
    assert.isNull(pendingRelation.confirmed_at)
  })

  test('missing or unsupported reauthentication purpose fails before redirect', async ({
    assert,
  }) => {
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: {
        providers: { google: provider('purpose-subject', 'purpose@example.test', true) },
      },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const start = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const created = await account.socialAuthentication.callback({
      state: start.state,
      callback: {},
    })
    if (created.status !== 'new' || !('userId' in created)) throw new Error('Expected account')
    for (const purpose of [undefined, 'unsupported' as never]) {
      await assert.rejects(
        () =>
          account.socialAuthentication.begin({
            provider: 'google',
            intent: 'reauth',
            current: current(created.userId),
            purpose,
            clientChallenge,
          }),
        'Invalid social transaction'
      )
    }
  })

  test('a disabled provider is not a remaining login method', async ({ assert }) => {
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: {
        providers: { github: provider('usable-subject', 'usable@example.test', true) },
      },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const login = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'login',
      clientChallenge,
    })
    const created = await account.socialAuthentication.callback({
      state: login.state,
      callback: {},
    })
    if (created.status !== 'new' || !('userId' in created)) throw new Error('Expected account')
    await kit.db.table('social_identities').insert({
      user_id: created.userId,
      provider: 'google',
      provider_user_id: 'disabled-subject',
      email_verified: true,
      confirmed_at: dbTime(kit),
      created_at: dbTime(kit),
      updated_at: dbTime(kit),
    })
    const reauth = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'reauth',
      purpose: 'social_unlink',
      current: current(created.userId),
      clientChallenge,
    })
    const proof = await account.socialAuthentication.callback({
      state: reauth.state,
      callback: {},
      current: current(created.userId),
    })
    if (proof.status !== 'reauthenticated') throw new Error('Expected proof')
    const relations = await account.socialAuthentication.list({ current: current(created.userId) })
    const github = relations.find((relation) => relation.provider === 'github')!
    await assert.rejects(
      () =>
        account.socialAuthentication.unlink({
          current: current(created.userId),
          identityId: github.id,
          proof: proof.proof,
        }),
      'At least one login method must remain'
    )
  })

  test('an unconfirmed address receives no relationship notice', async ({ assert }) => {
    const user = await insertUser(kit)
    await kit.db.from('users').where('id', user.id).update({
      unverified_email: user.email,
      email_verified_at: null,
    })
    const { account, recorder } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: { providers: { google: provider('inactive-link', null, false) } },
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
    await account.socialAuthentication.callback({
      state: started.state,
      callback: {},
      current: current(user.id),
    })
    const relations = await account.socialAuthentication.list({ current: current(user.id) })
    const relation = relations[0]
    const unlinkProof = await account.socialAuthentication.provePassword({
      current: current(user.id),
      password: 'password123',
      purpose: 'social_unlink',
    })
    await account.socialAuthentication.unlink({
      current: current(user.id),
      identityId: relation.id,
      proof: unlinkProof,
    })
    assert.lengthOf(
      recorder.calls.filter(
        (call) => call.method === 'socialIdentityLinked' || call.method === 'socialIdentityUnlinked'
      ),
      0
    )
  })

  test('provider failure and expired state have recoverable generic failures', async ({
    assert,
  }) => {
    let unavailable = true
    const providerAdapter = {
      authorizationUrl: async (state: string) => `https://provider.test/start?state=${state}`,
      resolve: async () => {
        if (unavailable) throw new Error('provider denied')
        return { subject: 'recovery-subject', email: 'recovery@example.test', emailVerified: true }
      },
    }
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: { providers: { google: providerAdapter } },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const started = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    await assert.rejects(
      () => account.socialAuthentication.callback({ state: started.state, callback: {} }),
      'Invalid social transaction'
    )
    unavailable = false
    await kit.db
      .from('social_transactions')
      .update({ expires_at: dbTime(kit, '2020-01-01T00:00:00.000Z') })
    await assert.rejects(
      () => account.socialAuthentication.callback({ state: started.state, callback: {} }),
      'Invalid social transaction'
    )
    const retry = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const recovered = await account.socialAuthentication.callback({
      state: retry.state,
      callback: {},
    })
    assert.equal(recovered.status, 'new')
  })

  test('competing registration continuations report identity conflict or linking', async ({
    assert,
  }) => {
    const subjects = { github: provider('first-continuation', null, false) }
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: { providers: subjects },
      authentication: { strategy: 'session', guard: 'web' },
    })
    async function continuation() {
      const started = await account.socialAuthentication.begin({
        provider: 'github',
        intent: 'login',
        clientChallenge,
      })
      const result = await account.socialAuthentication.callback({
        state: started.state,
        callback: {},
      })
      if (result.status !== 'new' || !('continuation' in result))
        throw new Error('Expected continuation')
      return result.continuation
    }
    const first = await continuation()
    const second = await continuation()
    await account.socialAuthentication.completeRegistration({
      continuation: first,
      email: 'first@example.test',
    })
    await assert.rejects(
      () =>
        account.socialAuthentication.completeRegistration({
          continuation: second,
          email: 'second@example.test',
        }),
      'Social identity is already linked'
    )
    subjects.github = provider('second-continuation', null, false)
    const third = await continuation()
    const existing = await account.socialAuthentication.completeRegistration({
      continuation: third,
      email: 'first@example.test',
    })
    assert.deepEqual(existing, { status: 'link_required' })
    assert.lengthOf(await kit.db.from('users'), 1)
  })

  test('a disabled provider cannot complete verified or unverified registration', async ({
    assert,
  }) => {
    for (const verified of [true, false]) {
      const email = verified ? 'disabled-verified@example.test' : 'disabled-pending@example.test'
      const config = {
        enabled: ['socialAuthentication', 'emailVerification'] as Array<
          'socialAuthentication' | 'emailVerification'
        >,
        registration: {
          availability: 'open' as const,
          mapFields: () => ({}),
        },
        authentication: { strategy: 'session' as const, guard: 'web' },
      }
      const beforeRemoval = makeService(kit, {
        ...config,
        socialAuthentication: {
          providers: {
            google: provider(`disabled-${verified}`, email, verified),
            github: provider('remaining-provider', 'remaining@example.test', true),
          },
        },
      }).account
      const started = await beforeRemoval.socialAuthentication.begin({
        provider: 'google',
        intent: 'login',
        clientChallenge,
      })
      const pending = await beforeRemoval.socialAuthentication.callback({
        state: started.state,
        callback: {},
      })
      if (pending.status !== 'new' || !('continuation' in pending))
        throw new Error('Expected registration continuation')
      const { account: afterRemoval, recorder } = makeService(kit, {
        ...config,
        socialAuthentication: {
          providers: { github: provider('remaining-provider', 'remaining@example.test', true) },
        },
      })
      let admitted = 0
      await assert.rejects(
        () =>
          afterRemoval.socialAuthentication.completeRegistration({
            continuation: pending.continuation,
            admit: async () => {
              admitted++
            },
          }),
        'Invalid social transaction'
      )
      assert.equal(admitted, 0)
      assert.lengthOf(await kit.db.from('users'), 0)
      assert.lengthOf(await kit.db.from('social_identities'), 0)
      assert.lengthOf(recorder.calls, 0)
    }
  })

  test('unlink notice failure occurs after relationship removal', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account, recorder } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: { providers: { google: provider('unlink-notice', null, false) } },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const linkProof = await account.socialAuthentication.provePassword({
      current: current(user.id),
      password: 'password123',
      purpose: 'social_link',
    })
    const started = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'link',
      current: current(user.id),
      clientChallenge,
      proof: linkProof,
    })
    await account.socialAuthentication.callback({
      state: started.state,
      callback: {},
      current: current(user.id),
    })
    const relations = await account.socialAuthentication.list({ current: current(user.id) })
    const unlinkProof = await account.socialAuthentication.provePassword({
      current: current(user.id),
      password: 'password123',
      purpose: 'social_unlink',
    })
    recorder.failOn('socialIdentityUnlinked')
    await assert.rejects(
      () =>
        account.socialAuthentication.unlink({
          current: current(user.id),
          identityId: relations[0].id,
          proof: unlinkProof,
        }),
      'Social identity unlinked but a follow-up failed'
    )
    assert.lengthOf(await kit.db.from('social_identities'), 0)
    assert.equal(
      recorder.calls.filter((call) => call.method === 'socialIdentityUnlinked').length,
      1
    )
  })
})
