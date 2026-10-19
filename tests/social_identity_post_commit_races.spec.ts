import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { clientChallenge, provider, current } from './helpers/social_identity.js'

test.group('social races and post-commit effects', (group) => {
  const kit = useTestApp(group)
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
