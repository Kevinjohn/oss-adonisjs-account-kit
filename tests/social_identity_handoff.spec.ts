import { test } from '@japa/runner'
import { advanceCredentialRevision } from '../src/authentication.js'
import { transaction } from '../src/db.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { verifier, clientChallenge, provider, current } from './helpers/social_identity.js'

test.group('social continuation and handoff', (group) => {
  const kit = useTestApp(group)
  const sessionGuard = {
    strategy: 'session' as const,
    name: 'web',
    establish: async () => 'session',
    terminate: async () => {},
  }

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
})
