import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import type { SocialProvider } from '../src/types.js'
import { clientChallenge, current, provider } from './helpers/social_identity.js'
import { dbTime } from './helpers/db_time.js'

test.group('social unlink atomicity', (group) => {
  const kit = useTestApp(group)

  const linkGoogle = async (
    account: ReturnType<typeof makeService>['account'],
    userId: number | string
  ) => {
    const linkProof = await account.socialAuthentication.provePassword({
      current: current(userId),
      password: 'password123',
      purpose: 'social_link',
    })
    const linking = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'link',
      current: current(userId),
      clientChallenge,
      proof: linkProof,
    })
    await account.socialAuthentication.callback({
      state: linking.state,
      callback: {},
      current: current(userId),
    })
    const [relation] = await account.socialAuthentication.list({ current: current(userId) })
    return relation
  }

  test('unlink advances the credential revision and ends the caller session', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const operations: string[] = []
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: { providers: { google: provider('revoked-unlink', user.email, true) } },
      authentication: { strategy: 'session', guard: 'web' },
      onCredentialsChangedTransaction: async (changed, context, trx) => {
        assert.equal(changed.id, user.id)
        assert.equal(context.userId, user.id)
        assert.isString(context.operationId)
        assert.lengthOf(await trx.from('social_identities').where('user_id', user.id), 0)
        operations.push(context.operation)
      },
    })
    const relation = await linkGoogle(account, user.id)
    const before = await kit.db.from('users').where('id', user.id).first()
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
    const after = await kit.db.from('users').where('id', user.id).first()
    assert.notEqual(String(after.credentials_changed_at), String(before.credentials_changed_at))
    assert.deepEqual(operations, ['social_unlink'])
    await assert.rejects(
      () => account.socialAuthentication.list({ current: current(user.id) }),
      'Invalid session'
    )
    assert.lengthOf(await kit.db.from('social_sensitive_proofs').where('user_id', user.id), 0)
    assert.lengthOf(await kit.db.from('social_transactions').where('user_id', user.id), 0)
  })

  test('unlink runs the post-commit credential hook after the relationship is removed', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const seen: Array<{ operation: string; remaining: number }> = []
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: { providers: { google: provider('hooked-unlink', user.email, true) } },
      authentication: { strategy: 'session', guard: 'web' },
      onCredentialsChanged: async (changed, context) => {
        const remaining = await kit.db.from('social_identities').where('user_id', changed.id)
        seen.push({ operation: context.operation, remaining: remaining.length })
      },
    })
    const relation = await linkGoogle(account, user.id)
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
    assert.deepEqual(seen, [{ operation: 'social_unlink', remaining: 0 }])
  })

  test('unlink invalidates proof issued through the removed provider', async ({ assert }) => {
    const user = await insertUser(kit, { email: 'unlink-proof@example.test', password: null })
    const timestamp = dbTime(kit)
    await kit.db.table('social_identities').insert([
      {
        user_id: user.id,
        provider: 'google',
        provider_user_id: 'removed-proof-subject',
        email_verified: true,
        confirmed_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
      {
        user_id: user.id,
        provider: 'github',
        provider_user_id: 'remaining-proof-subject',
        email_verified: true,
        confirmed_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      },
    ])
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification', 'emailPasswordManagement'],
      socialAuthentication: {
        providers: {
          google: provider('removed-proof-subject', user.email, true),
          github: provider('remaining-proof-subject', user.email, true),
        },
      },
      authentication: { strategy: 'session', guard: 'web' },
      minRequestMs: 0,
    })
    const reauth = async (purpose: 'password_change' | 'social_unlink') => {
      const started = await account.socialAuthentication.begin({
        provider: 'google',
        intent: 'reauth',
        purpose,
        current: current(user.id),
        clientChallenge,
      })
      const result = await account.socialAuthentication.callback({
        state: started.state,
        callback: {},
        current: current(user.id),
      })
      if (result.status !== 'reauthenticated') throw new Error('Expected recent proof')
      return result.proof
    }
    const stale = await reauth('password_change')
    const unlinkProof = await reauth('social_unlink')
    const identities = await account.socialAuthentication.list({ current: current(user.id) })
    const google = identities.find((item) => item.provider === 'google')!
    await account.socialAuthentication.unlink({
      current: current(user.id),
      identityId: google.id,
      proof: unlinkProof,
    })
    await assert.rejects(
      () =>
        account.emailPasswordManagement.changePassword({
          actorId: user.id,
          recentProof: stale,
          newPassword: 'new-Password-9!',
        }),
      'Invalid recent authentication proof'
    )
  })

  test('unlink and relink cannot revive pending or in-flight reauthentication', async ({
    assert,
  }) => {
    const user = await insertUser(kit, { email: 'reauth-race@example.test', password: null })
    const timestamp = dbTime(kit)
    const googleSubject = 'reauth-race-google'
    const githubSubject = 'reauth-race-github'
    const association = (name: 'google' | 'github', subject: string) => ({
      user_id: user.id,
      provider: name,
      provider_user_id: subject,
      email: user.email,
      email_verified: true,
      confirmed_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    })
    await kit.db
      .table('social_identities')
      .insert([association('google', googleSubject), association('github', githubSubject)])
    let enterVerifier!: () => void
    let finishVerifier!: () => void
    const verifierEntered = new Promise<void>((resolve) => (enterVerifier = resolve))
    const verifierReleased = new Promise<void>((resolve) => (finishVerifier = resolve))
    const adapters: { google: SocialProvider; github: SocialProvider } = {
      google: {
        ...provider(googleSubject, user.email, true),
        verifyFreshAuthentication: async (_callback, expected) => {
          enterVerifier()
          await verifierReleased
          return { verified: true, subject: expected.subject, authenticatedAt: timestamp }
        },
      },
      github: provider(githubSubject, user.email, true),
    }
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      socialAuthentication: { providers: adapters },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const actor = current(user.id)
    const startGoogle = () =>
      account.socialAuthentication.begin({
        provider: 'google',
        intent: 'reauth',
        purpose: 'social_unlink',
        current: actor,
        clientChallenge,
      })
    const pending = await startGoogle()
    const inFlight = await startGoogle()
    const lateCallback = account.socialAuthentication.callback({
      state: inFlight.state,
      callback: {},
      current: actor,
    })
    await verifierEntered
    const githubState = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'reauth',
      purpose: 'social_unlink',
      current: actor,
      clientChallenge,
    })
    const githubProof = await account.socialAuthentication.callback({
      state: githubState.state,
      callback: {},
      current: actor,
    })
    if (githubProof.status !== 'reauthenticated') throw new Error('Expected unlink proof')
    const identities = await account.socialAuthentication.list({ current: actor })
    await account.socialAuthentication.unlink({
      current: actor,
      identityId: identities.find((identity) => identity.provider === 'google')!.id,
      proof: githubProof.proof,
    })
    assert.lengthOf(
      await kit.db.from('social_transactions').where('user_id', user.id).where('intent', 'reauth'),
      0
    )
    await kit.db.table('social_identities').insert(association('google', googleSubject))
    finishVerifier()
    await assert.rejects(() => lateCallback, 'Invalid social transaction')
    await assert.rejects(
      () =>
        account.socialAuthentication.callback({
          state: pending.state,
          callback: {},
          current: actor,
        }),
      'Invalid social transaction'
    )
    assert.lengthOf(await kit.db.from('social_sensitive_proofs').where('user_id', user.id), 0)
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
