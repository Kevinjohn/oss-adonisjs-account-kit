import { test } from '@japa/runner'
import { advanceCredentialRevision } from '../src/authentication.js'
import { transaction } from '../src/db.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { verifier, clientChallenge, provider, current } from './helpers/social_identity.js'
import { dbTime } from './helpers/db_time.js'

test.group('social continuation and handoff', (group) => {
  const kit = useTestApp(group)
  const sessionGuard = {
    strategy: 'session' as const,
    name: 'web',
    establish: async () => 'session',
    terminate: async () => {},
  }

  test('joint email proof and fresh provider callback confirms a passwordless account', async ({
    assert,
  }) => {
    const { account, recorder } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: {
        providers: { github: provider('fresh-subject', 'owner@example.test', false) },
      },
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
    const issued = recorder.calls.find((call) => call.method === 'accountActivationProvision')
    if (!issued) throw new Error('Expected an email proof')
    const verificationToken = new URL(issued.args[1] as string).pathname.split('/').at(-1)!
    const confirm = await account.socialAuthentication.beginConfirmation({
      provider: 'github',
      verificationToken,
      clientChallenge,
    })
    assert.notInclude(confirm.url, verificationToken)
    await assert.rejects(
      () =>
        account.socialAuthentication.callback({
          state: confirm.state,
          callback: {},
          verificationToken: 'bad',
        }),
      'Invalid social transaction'
    )
    const result = await account.socialAuthentication.callback({
      state: confirm.state,
      callback: {},
    })
    assert.equal(result.status, 'linked')
    const row = await kit.db.from('social_identities').first()
    assert.isNotNull(row.confirmed_at)
    const user = await kit.db.from('users').first()
    assert.isNull(user.password)
    assert.isNull(user.unverified_email)
    const next = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'login',
      clientChallenge,
    })
    const login = await account.socialAuthentication.callback({ state: next.state, callback: {} })
    assert.equal(login.status, 'linked')
  })

  test('PKCE handoff issues one guard credential and rejects replay or a wrong verifier', async ({
    assert,
  }) => {
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: {
        providers: {
          google: provider('handoff-subject', 'handoff@example.test', true),
          github: provider('github-handoff-subject', 'github-handoff@example.test', true),
        },
      },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const start = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const result = await account.socialAuthentication.callback({ state: start.state, callback: {} })
    if (result.status !== 'new' || !('handoffCode' in result) || !result.handoffCode)
      throw new Error('Expected handoff')
    assert.notInclude(start.url, result.handoffCode)
    let issued = 0
    const guard = {
      strategy: 'session' as const,
      name: 'web',
      establish: async () => {
        issued++
        return 'cookie'
      },
      terminate: async () => {},
    }
    await assert.rejects(
      () =>
        account.socialAuthentication.redeemHandoff({
          code: result.handoffCode!,
          verifier: 'b'.repeat(43),
          guard,
        }),
      'Invalid social transaction'
    )
    const exchanged = await account.socialAuthentication.redeemHandoff({
      code: result.handoffCode,
      verifier,
      guard,
    })
    assert.equal(exchanged.credential, 'cookie')
    assert.equal(exchanged.provider, 'google')
    assert.equal(issued, 1)
    await assert.rejects(
      () =>
        account.socialAuthentication.redeemHandoff({ code: result.handoffCode!, verifier, guard }),
      'Invalid social transaction'
    )
    const githubStart = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'login',
      clientChallenge,
    })
    const githubResult = await account.socialAuthentication.callback({
      state: githubStart.state,
      callback: {},
    })
    if (
      githubResult.status !== 'new' ||
      !('handoffCode' in githubResult) ||
      !githubResult.handoffCode
    )
      throw new Error('Expected GitHub handoff')
    const githubExchange = await account.socialAuthentication.redeemHandoff({
      code: githubResult.handoffCode,
      verifier,
      guard,
    })
    assert.equal(githubExchange.provider, 'github')
  })

  test('application admission and required field mapping run only in trusted completion', async ({
    assert,
  }) => {
    let mapped = 0
    let admitted = 0
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: {
        availability: 'application',
        mapFields: (data) => {
          mapped++
          if ((data as { consent?: boolean } | undefined)?.consent !== true)
            throw new Error('Consent required')
          return { consent: true }
        },
      },
      socialAuthentication: {
        providers: { google: provider('admitted-subject', 'admitted@example.test', true) },
      },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const start = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const pending = await account.socialAuthentication.callback({
      state: start.state,
      callback: {},
    })
    assert.equal(pending.status, 'new')
    if (!('continuation' in pending) || !pending.continuation)
      throw new Error('Expected continuation')
    await assert.rejects(
      () =>
        account.socialAuthentication.completeRegistration({
          continuation: pending.continuation!,
          registrationData: { consent: true },
        }),
      'Invalid social transaction'
    )
    await assert.rejects(
      () =>
        account.socialAuthentication.completeRegistration({
          continuation: pending.continuation!,
          admit: async () => {
            admitted++
          },
        }),
      'Consent required'
    )
    assert.lengthOf(await kit.db.from('users'), 0)
    const completed = await account.socialAuthentication.completeRegistration({
      continuation: pending.continuation,
      registrationData: { consent: true },
      admit: async (_profile, trx) => {
        admitted++
        await trx.rawQuery('select 1')
      },
    })
    assert.equal(completed.status, 'new')
    assert.equal(mapped, 2)
    assert.equal(admitted, 2)
    assert.lengthOf(await kit.db.from('users'), 1)
  })

  test('fresh provider proof cannot remove a social-only account’s final login method', async ({
    assert,
  }) => {
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: {
        providers: { github: provider('last-subject', 'last@example.test', true) },
      },
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
    if (created.status !== 'new' || !('userId' in created)) throw new Error('Expected account')
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
    if (proof.status !== 'reauthenticated') throw new Error('Expected recent proof')
    const identities = await account.socialAuthentication.list({ current: current(created.userId) })
    await assert.rejects(
      () =>
        account.socialAuthentication.unlink({
          current: current(created.userId),
          identityId: identities[0].id,
          proof: proof.proof,
        }),
      'At least one login method must remain'
    )
    assert.lengthOf(await kit.db.from('social_identities'), 1)
  })

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
})
