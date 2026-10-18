import { DateTime } from 'luxon'
import { createHash } from 'node:crypto'
import { test } from '@japa/runner'
import { advanceCredentialRevision } from '../src/authentication.js'
import { createAllySocialProvider } from '../src/ally_social_provider.js'
import { transaction } from '../src/db.js'
import { consumeSocialSensitiveProof } from '../src/social_identity.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import type { SocialProvider, VerifiedSocialAuthentication } from '../src/types.js'
import { clientChallenge, provider } from './helpers/social_identity.js'
import { dbTime } from './helpers/db_time.js'

test.group('social proof and relationship atomicity', (group) => {
  const kit = useTestApp(group)
  const current = (userId: number | string) => ({ userId, revision: null })

  test('standard Ally cannot reauthenticate; verified assurance must be recent, bound and well formed', async ({
    assert,
  }) => {
    const subject = 'freshness-subject'
    const email = 'freshness@example.test'
    const adapters: { google: SocialProvider } = { google: provider(subject, email, true) }
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      socialAuthentication: { providers: adapters },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const login = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const created = await account.socialAuthentication.callback({
      state: login.state,
      callback: {},
    })
    if (created.status !== 'new' || !('userId' in created))
      throw new Error('Expected social account')
    const actor = current(created.userId)
    adapters.google = createAllySocialProvider({
      authorizationUrl: async (state) => `https://provider.test/start?state=${state}`,
      user: async () => ({ id: subject, email, emailVerificationState: 'verified' }),
    })
    await assert.rejects(
      () =>
        account.socialAuthentication.begin({
          provider: 'google',
          intent: 'reauth',
          purpose: 'password_change',
          current: actor,
          clientChallenge,
        }),
      'Invalid recent authentication proof'
    )
    const begin = async () =>
      account.socialAuthentication.begin({
        provider: 'google',
        intent: 'reauth',
        purpose: 'password_change',
        current: actor,
        clientChallenge,
      })
    const valid = (): VerifiedSocialAuthentication => ({
      verified: true,
      subject,
      authenticatedAt: new Date().toISOString(),
    })
    const cases: Array<VerifiedSocialAuthentication | null> = [
      null,
      { ...valid(), authenticatedAt: dbTime(kit, DateTime.utc().minus({ milliseconds: 60_000 })) },
      { ...valid(), authenticatedAt: 'yesterday' },
      { ...valid(), authenticatedAt: dbTime(kit, DateTime.utc().plus({ milliseconds: 1_000 })) },
      { ...valid(), subject: 'other-subject' },
      { ...valid(), verified: false } as unknown as VerifiedSocialAuthentication,
      {
        verified: true,
        subject,
        issuedAt: Math.floor(Date.now() / 1000),
      } as unknown as VerifiedSocialAuthentication,
    ]
    for (const evidence of cases) {
      adapters.google = {
        ...provider(subject, email, true),
        verifyFreshAuthentication: async () => evidence,
      }
      const started = await begin()
      await assert.rejects(
        () =>
          account.socialAuthentication.callback({
            state: started.state,
            callback: {},
            current: actor,
          }),
        'Invalid recent authentication proof'
      )
      assert.lengthOf(await kit.db.from('social_sensitive_proofs'), 0)
    }
    adapters.google = {
      ...provider(subject, email, true),
      verifyFreshAuthentication: async () => valid(),
    }
    const staleRevision = await begin()
    const state = await kit.db
      .from('social_transactions')
      .where('hash', createHash('sha256').update(staleRevision.state).digest('hex'))
      .first()
    await kit.db
      .from('social_transactions')
      .where('id', state.id)
      .update({ credential_revision: 'stale-revision' })
    await assert.rejects(
      () =>
        account.socialAuthentication.callback({
          state: staleRevision.state,
          callback: {},
          current: actor,
        }),
      'Invalid recent authentication proof'
    )
    assert.lengthOf(await kit.db.from('social_sensitive_proofs'), 0)
    const fresh = await begin()
    const callback = { providerAssertion: 'opaque-fixture' }
    adapters.google = {
      ...provider(subject, email, true),
      verifyFreshAuthentication: async (received, expected) => {
        assert.strictEqual(received, callback)
        assert.deepEqual(expected, { state: fresh.state, subject })
        return valid()
      },
    }
    const result = await account.socialAuthentication.callback({
      state: fresh.state,
      callback,
      current: actor,
    })
    assert.equal(result.status, 'reauthenticated')
    const wrongState = await begin()
    adapters.google.verifyFreshAuthentication = async (_received, expected) =>
      expected.state === fresh.state ? valid() : null
    await assert.rejects(
      () =>
        account.socialAuthentication.callback({
          state: wrongState.state,
          callback,
          current: actor,
        }),
      'Invalid recent authentication proof'
    )
    const boundary = await begin()
    const boundaryRow = await kit.db
      .from('social_transactions')
      .where('hash', createHash('sha256').update(boundary.state).digest('hex'))
      .first()
    const boundaryTime = new Date(boundaryRow.created_at).getTime() - 30_000
    adapters.google.verifyFreshAuthentication = async () => ({
      ...valid(),
      authenticatedAt: new Date(boundaryTime).toISOString(),
    })
    const atBoundary = await account.socialAuthentication.callback({
      state: boundary.state,
      callback,
      current: actor,
    })
    assert.equal(atBoundary.status, 'reauthenticated')
    const beyond = await begin()
    const beyondRow = await kit.db
      .from('social_transactions')
      .where('hash', createHash('sha256').update(beyond.state).digest('hex'))
      .first()
    adapters.google.verifyFreshAuthentication = async () => ({
      ...valid(),
      authenticatedAt: new Date(new Date(beyondRow.created_at).getTime() - 30_001).toISOString(),
    })
    await assert.rejects(
      () =>
        account.socialAuthentication.callback({
          state: beyond.state,
          callback,
          current: actor,
        }),
      'Invalid recent authentication proof'
    )
  })

  test('provider proof authorizes social-only email changes once in the account transaction', async ({
    assert,
  }) => {
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification', 'emailPasswordManagement'],
      socialAuthentication: {
        providers: { google: provider('email-proof-subject', 'proof@example.test', true) },
      },
      authentication: { strategy: 'session', guard: 'web' },
      minRequestMs: 0,
    })
    const login = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const created = await account.socialAuthentication.callback({
      state: login.state,
      callback: {},
    })
    if (created.status !== 'new' || !('userId' in created))
      throw new Error('Expected social account')
    const actorId = created.userId
    const prove = async (purpose: 'email_change' | 'password_change') => {
      const started = await account.socialAuthentication.begin({
        provider: 'google',
        intent: 'reauth',
        purpose,
        current: current(actorId),
        clientChallenge,
      })
      const result = await account.socialAuthentication.callback({
        state: started.state,
        callback: {},
        current: current(actorId),
      })
      if (result.status !== 'reauthenticated') throw new Error('Expected recent proof')
      return result.proof
    }
    await assert.rejects(
      () =>
        account.emailPasswordManagement.requestEmailChange({
          actorId,
          newEmail: 'next@example.test',
        }),
      'IdentityNotConfirmedError'
    )
    const wrong = await prove('password_change')
    await assert.rejects(
      () =>
        account.emailPasswordManagement.requestEmailChange({
          actorId,
          recentProof: wrong,
          newEmail: 'next@example.test',
        }),
      'Invalid recent authentication proof'
    )
    const proof = await prove('email_change')
    await assert.rejects(
      () =>
        account.emailPasswordManagement.requestEmailChange({
          actorId,
          recentProof: proof,
          newEmail: 'bad',
        }),
      'Invalid email'
    )
    await insertUser(kit, { email: 'taken@example.test' })
    await assert.rejects(
      () =>
        account.emailPasswordManagement.requestEmailChange({
          actorId,
          recentProof: proof,
          newEmail: 'taken@example.test',
        }),
      'EmailAlreadyRegisteredError'
    )
    await account.emailPasswordManagement.requestEmailChange({
      actorId,
      recentProof: proof,
      newEmail: 'next@example.test',
    })
    const user = await kit.db.from('users').where('id', actorId).first()
    assert.equal(user.unverified_email, 'next@example.test')
    await assert.rejects(
      () =>
        account.emailPasswordManagement.requestEmailChange({
          actorId,
          recentProof: proof,
          newEmail: 'again@example.test',
        }),
      'Invalid recent authentication proof'
    )
  })

  test('provider proof establishes a first password and never substitutes for a password account', async ({
    assert,
  }) => {
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification', 'emailPasswordManagement'],
      socialAuthentication: {
        providers: {
          github: provider('password-proof-subject', 'first-password@example.test', true),
        },
      },
      authentication: { strategy: 'session', guard: 'web' },
      minRequestMs: 0,
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
    if (created.status !== 'new' || !('userId' in created))
      throw new Error('Expected social account')
    const actorId = created.userId
    const started = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'reauth',
      purpose: 'password_change',
      current: current(actorId),
      clientChallenge,
    })
    const result = await account.socialAuthentication.callback({
      state: started.state,
      callback: {},
      current: current(actorId),
    })
    if (result.status !== 'reauthenticated') throw new Error('Expected recent proof')
    await account.emailPasswordManagement.changePassword({
      actorId,
      recentProof: result.proof,
      newPassword: 'first-Password-9!',
    })
    const user = await kit.db.from('users').where('id', actorId).first()
    assert.isNotNull(user.password)
    await assert.rejects(
      () =>
        account.emailPasswordManagement.changePassword({
          actorId,
          recentProof: result.proof,
          newPassword: 'another-Password-9!',
        }),
      'IdentityNotConfirmedError'
    )
    await account.emailPasswordManagement.changePassword({
      actorId,
      currentPassword: 'first-Password-9!',
      newPassword: 'another-Password-9!',
    })
  })

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
