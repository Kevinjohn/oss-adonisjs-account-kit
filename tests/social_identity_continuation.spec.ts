import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
import { makeService } from './helpers/fakes.js'
import { verifier, clientChallenge, provider } from './helpers/social_identity.js'

test.group('social continuation and handoff', (group) => {
  const kit = useTestApp(group)
  const current = (userId: number | string) => ({ userId, revision: null })

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
})
