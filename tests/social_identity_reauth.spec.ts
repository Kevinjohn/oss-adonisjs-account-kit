import { DateTime } from 'luxon'
import { createHash } from 'node:crypto'
import { test } from '@japa/runner'
import { createAllySocialProvider } from '../src/ally_social_provider.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import type { SocialProvider, VerifiedSocialAuthentication } from '../src/types.js'
import { clientChallenge, current, provider } from './helpers/social_identity.js'
import { dbTime } from './helpers/db_time.js'

test.group('social reauthentication proof atomicity', (group) => {
  const kit = useTestApp(group)

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
})
