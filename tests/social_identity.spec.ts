import { createHash } from 'node:crypto'
import { test } from '@japa/runner'
import { advanceCredentialRevision } from '../src/authentication.js'
import { createAllySocialProvider } from '../src/ally_social_provider.js'
import { transaction } from '../src/db.js'
import { consumeSocialSensitiveProof } from '../src/social_identity.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import type { SocialProvider, VerifiedSocialAuthentication } from '../src/types.js'

const verifier = 'a'.repeat(43)
const clientChallenge = createHash('sha256').update(verifier).digest('base64url')

/** Trusted deterministic adapter fixture; production Ally does not attest authentication time. */
const provider = (subject: string, email: string | null, verified: boolean) => ({
  authorizationUrl: async (state: string) => `https://provider.test/start?state=${state}`,
  resolve: async () => ({ subject, email, emailVerified: verified }),
  verifyFreshAuthentication: async () => ({
    verified: true as const,
    subject,
    authenticatedAt: new Date().toISOString(),
  }),
})

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
      { ...valid(), authenticatedAt: new Date(Date.now() - 60_000).toISOString() },
      { ...valid(), authenticatedAt: 'yesterday' },
      { ...valid(), authenticatedAt: new Date(Date.now() + 1_000).toISOString() },
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
    const timestamp = new Date().toISOString()
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
    const timestamp = new Date().toISOString()
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

test.group('social expiry cleanup', (group) => {
  const kit = useTestApp(group)
  test('prunes expired transaction, recent-proof, and handoff rows in bounded batches', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const past = '2020-01-01T00:00:00.000Z'
    await kit.db.table('social_transactions').insert({
      hash: 'a'.repeat(64),
      provider: 'google',
      intent: 'login',
      client_challenge: clientChallenge,
      expires_at: past,
      created_at: past,
    })
    await kit.db.table('social_sensitive_proofs').insert({
      hash: 'b'.repeat(64),
      user_id: user.id,
      purpose: 'social_link',
      expires_at: past,
      created_at: past,
    })
    await kit.db.table('social_identities').insert({
      user_id: user.id,
      provider: 'google',
      provider_user_id: 'expired-handoff-subject',
      email_verified: false,
      created_at: past,
      updated_at: past,
    })
    const relation = await kit.db.from('social_identities').first()
    await kit.db.table('social_handoff_codes').insert({
      hash: 'c'.repeat(64),
      user_id: user.id,
      social_identity_id: relation.id,
      client_challenge: clientChallenge,
      expires_at: past,
      created_at: past,
    })
    const { account } = makeService(kit)
    const counts = await account.maintenance.prune({ batchSize: 1 })
    assert.equal(counts.socialTransactions, 1)
    assert.equal(counts.socialSensitiveProofs, 1)
    assert.equal(counts.socialHandoffCodes, 1)
    assert.lengthOf(await kit.db.from('social_transactions'), 0)
    assert.lengthOf(await kit.db.from('social_sensitive_proofs'), 0)
    assert.lengthOf(await kit.db.from('social_handoff_codes'), 0)
  })
})

test.group('social races and post-commit effects', (group) => {
  const kit = useTestApp(group)
  const current = (userId: number | string) => ({ userId, revision: null })
  const configuration = (subject: string) => ({
    enabled: ['socialAuthentication', 'emailVerification'] as Array<
      'socialAuthentication' | 'emailVerification'
    >,
    registration: { availability: 'open' as const },
    socialAuthentication: { providers: { github: provider(subject, null, false) } },
    authentication: { strategy: 'session' as const, guard: 'web' },
  })

  test('concurrent links of one provider subject attach to exactly one account', async ({
    assert,
  }) => {
    const a = await insertUser(kit, { email: 'a@example.test' })
    const b = await insertUser(kit, { email: 'b@example.test' })
    const { account } = makeService(kit, configuration('shared-subject'))
    const [aState, bState] = await Promise.all([
      account.socialAuthentication.begin({
        provider: 'github',
        intent: 'link',
        current: current(a.id),
        clientChallenge,
      }),
      account.socialAuthentication.begin({
        provider: 'github',
        intent: 'link',
        current: current(b.id),
        clientChallenge,
      }),
    ])
    const [aProof, bProof] = await Promise.all([
      account.socialAuthentication.provePassword({
        current: current(a.id),
        password: 'password123',
        purpose: 'social_link',
      }),
      account.socialAuthentication.provePassword({
        current: current(b.id),
        password: 'password123',
        purpose: 'social_link',
      }),
    ])
    const outcomes = await Promise.allSettled([
      account.socialAuthentication.callback({
        state: aState.state,
        callback: {},
        current: current(a.id),
        proof: aProof,
      }),
      account.socialAuthentication.callback({
        state: bState.state,
        callback: {},
        current: current(b.id),
        proof: bProof,
      }),
    ])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1)
    const rows = await kit.db.from('social_identities')
    assert.lengthOf(rows, 1)
    assert.include([a.id, b.id], rows[0].user_id)
  })

  test('link notice failure happens after the association commits', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account, recorder } = makeService(kit, configuration('notice-subject'))
    recorder.failOn('socialIdentityLinked')
    const state = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'link',
      current: current(user.id),
      clientChallenge,
    })
    const proof = await account.socialAuthentication.provePassword({
      current: current(user.id),
      password: 'password123',
      purpose: 'social_link',
    })
    await assert.rejects(
      () =>
        account.socialAuthentication.callback({
          state: state.state,
          callback: {},
          current: current(user.id),
          proof,
        }),
      'Social identity linked but notice failed'
    )
    assert.lengthOf(await kit.db.from('social_identities'), 1)
    assert.equal(recorder.calls.filter((call) => call.method === 'socialIdentityLinked').length, 1)
  })

  test('first password reset keeps confirmed provider and invalidates recent proof', async ({
    assert,
  }) => {
    const { account, recorder } = makeService(kit, {
      ...configuration('reset-subject'),
      enabled: ['socialAuthentication', 'emailVerification', 'passwordReset'],
      socialAuthentication: {
        providers: { github: provider('reset-subject', 'person@example.test', true) },
      },
      minRequestMs: 0,
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
    assert.equal(proof.status, 'reauthenticated')
    assert.lengthOf(await kit.db.from('social_sensitive_proofs'), 1)
    const pending = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'reauth',
      purpose: 'password_change',
      current: current(created.userId),
      clientChallenge,
    })
    assert.lengthOf(await kit.db.from('social_transactions').where('user_id', created.userId), 1)
    await account.passwordReset.request({ email: 'person@example.test', clientKey: 'client' })
    const sent = recorder.calls.find((call) => call.method === 'passwordResetProvision')
    if (!sent) throw new Error('Expected password reset proof')
    const token = new URL(sent.args[1] as string).pathname.split('/').at(-1)!
    await account.passwordReset.reset({ token, password: 'new-password123' })
    const user = await kit.db.from('users').where('id', created.userId).first()
    assert.isNotNull(user.password)
    const relationships = await kit.db.from('social_identities').where('user_id', created.userId)
    assert.lengthOf(relationships, 1)
    assert.isNotNull(relationships[0].confirmed_at)
    assert.lengthOf(await kit.db.from('social_sensitive_proofs'), 0)
    assert.lengthOf(await kit.db.from('social_transactions').where('user_id', created.userId), 0)
    await assert.rejects(
      () =>
        account.socialAuthentication.callback({
          state: pending.state,
          callback: {},
          current: current(created.userId),
        }),
      'Invalid social transaction'
    )
    const signedIn = await account.authentication.login(
      {
        email: 'person@example.test',
        password: 'new-password123',
        clientKey: 'reset-reentry-client',
      },
      {
        strategy: 'session',
        name: 'web',
        establish: async (_userId, revision) => revision,
        terminate: async () => {},
      }
    )
    const postResetCurrent = { userId: created.userId, revision: signedIn.credential }
    const unlinkProof = await account.socialAuthentication.provePassword({
      current: postResetCurrent,
      password: 'new-password123',
      purpose: 'social_unlink',
    })
    const [confirmed] = await account.socialAuthentication.list({ current: postResetCurrent })
    await account.socialAuthentication.unlink({
      current: postResetCurrent,
      identityId: confirmed.id,
      proof: unlinkProof,
    })
    assert.lengthOf(await kit.db.from('social_identities').where('user_id', created.userId), 0)
    // Unlinking advanced the revision again, so the post-reset session is over too.
    await assert.rejects(
      () =>
        account.socialAuthentication.unlink({
          current: postResetCurrent,
          identityId: confirmed.id,
          proof: unlinkProof,
        }),
      'Invalid session'
    )
  })
})

test.group('social policy and method races', (group) => {
  const kit = useTestApp(group)
  const current = (userId: number | string) => ({ userId, revision: null })

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
      confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
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
    const timestamp = new Date().toISOString()
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
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
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
      confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
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
    await kit.db.from('social_transactions').update({ expires_at: '2020-01-01T00:00:00.000Z' })
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
