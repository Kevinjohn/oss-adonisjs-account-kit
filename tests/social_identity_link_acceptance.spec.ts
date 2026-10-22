import { test } from '@japa/runner'
import { SocialLinkRefusedError } from '../src/errors.js'
import { managedErrorResponse } from '../src/http/responses.js'
import type { AccountUser, SocialLinkProfile } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { clientChallenge, current, provider } from './helpers/social_identity.js'

type AcceptLink = (user: AccountUser, profile: SocialLinkProfile) => Promise<void>

test.group('social link acceptance', (group) => {
  const kit = useTestApp(group)

  function linkService(acceptLink: AcceptLink, subject = 'accepted-subject') {
    return makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: {
        providers: { google: provider(subject, 'provider@example.test', true) },
        acceptLink: (user, profile) => acceptLink(user, profile),
      },
      authentication: { strategy: 'session', guard: 'web' },
    })
  }

  async function beginLink(
    account: ReturnType<typeof makeService>['account'],
    userId: number | string
  ) {
    const proof = await account.socialAuthentication.provePassword({
      current: current(userId),
      password: 'password123',
      purpose: 'social_link',
    })
    const started = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'link',
      current: current(userId),
      clientChallenge,
    })
    return { proof, state: started.state }
  }

  test('links and sends the notice when acceptLink returns', async ({ assert }) => {
    const user = await insertUser(kit)
    const calls: Array<{ user: AccountUser; profile: SocialLinkProfile }> = []
    const { account, recorder } = linkService(async (accepted, profile) => {
      calls.push({ user: accepted, profile })
    })
    const { proof, state } = await beginLink(account, user.id)
    const result = await account.socialAuthentication.callback({
      state,
      callback: {},
      current: current(user.id),
      proof,
    })
    assert.equal(result.status, 'linked')
    assert.lengthOf(calls, 1)
    assert.equal(String(calls[0].user.id), String(user.id))
    assert.equal(calls[0].user.email, user.email)
    assert.deepEqual(calls[0].profile, {
      provider: 'google',
      subject: 'accepted-subject',
      email: 'provider@example.test',
      emailVerified: true,
    })
    assert.lengthOf(await kit.db.from('social_identities'), 1)
    assert.equal(recorder.calls.filter((call) => call.method === 'socialIdentityLinked').length, 1)
  })

  test('a refusal writes nothing and keeps the proof and state usable', async ({ assert }) => {
    const user = await insertUser(kit)
    let refuse = true
    const { account, recorder } = linkService(async () => {
      if (refuse) throw new SocialLinkRefusedError()
    })
    const { proof, state } = await beginLink(account, user.id)
    const input = { state, callback: {}, current: current(user.id), proof }
    const refused = await account.socialAuthentication.callback(input).catch((error) => error)
    assert.instanceOf(refused, SocialLinkRefusedError)
    assert.equal(refused.code, 'E_ACCOUNT_KIT_SOCIAL_LINK_REFUSED')
    assert.equal(refused.status, 403)
    assert.deepEqual(managedErrorResponse(refused)?.status, 403)
    assert.deepEqual(managedErrorResponse(refused)?.body, {
      errors: [{ code: 'E_ACCOUNT_KIT_SOCIAL_LINK_REFUSED', message: 'Account request rejected.' }],
    })
    assert.lengthOf(await kit.db.from('social_identities'), 0)
    assert.isFalse(recorder.calls.some((call) => call.method === 'socialIdentityLinked'))

    refuse = false
    const linked = await account.socialAuthentication.callback(input)
    assert.equal(linked.status, 'linked')
    assert.lengthOf(await kit.db.from('social_identities'), 1)
  })

  test('another acceptLink error rolls back and surfaces unchanged', async ({ assert }) => {
    const user = await insertUser(kit)
    const failure = new Error('Policy store unavailable')
    const { account, recorder } = linkService(async () => {
      throw failure
    })
    const { proof, state } = await beginLink(account, user.id)
    const thrown = await account.socialAuthentication
      .callback({ state, callback: {}, current: current(user.id), proof })
      .catch((error) => error)
    assert.strictEqual(thrown, failure)
    assert.lengthOf(await kit.db.from('social_identities'), 0)
    assert.isFalse(recorder.calls.some((call) => call.method === 'socialIdentityLinked'))
  })

  test('acceptLink is not called when the proof or the duplicate check fails', async ({
    assert,
  }) => {
    const owner = await insertUser(kit)
    const other = await insertUser(kit, { email: 'other@example.test' })
    let called = 0
    const { account } = linkService(async () => {
      called++
    })
    const missing = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'link',
      current: current(owner.id),
      clientChallenge,
    })
    await assert.rejects(
      () =>
        account.socialAuthentication.callback({
          state: missing.state,
          callback: {},
          current: current(owner.id),
        }),
      'Invalid recent authentication proof'
    )
    assert.equal(called, 0)

    const first = await beginLink(account, owner.id)
    await account.socialAuthentication.callback({
      state: first.state,
      callback: {},
      current: current(owner.id),
      proof: first.proof,
    })
    assert.equal(called, 1)
    const duplicate = await beginLink(account, other.id)
    await assert.rejects(
      () =>
        account.socialAuthentication.callback({
          state: duplicate.state,
          callback: {},
          current: current(other.id),
          proof: duplicate.proof,
        }),
      'Social identity is already linked'
    )
    assert.equal(called, 1)
  })

  test('acceptLink is not called for login, confirm or reauth', async ({ assert }) => {
    let called = 0
    const { account, recorder } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'open' },
      socialAuthentication: {
        providers: { github: provider('flow-subject', 'flow@example.test', false) },
        acceptLink: async () => {
          called++
          throw new SocialLinkRefusedError()
        },
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
    const confirmed = await account.socialAuthentication.callback({
      state: confirm.state,
      callback: {},
    })
    if (confirmed.status !== 'linked') throw new Error('Expected confirmation')
    const next = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'login',
      clientChallenge,
    })
    const login = await account.socialAuthentication.callback({ state: next.state, callback: {} })
    assert.equal(login.status, 'linked')
    const reauth = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'reauth',
      purpose: 'social_unlink',
      current: current(confirmed.userId),
      clientChallenge,
    })
    const proof = await account.socialAuthentication.callback({
      state: reauth.state,
      callback: {},
      current: current(confirmed.userId),
    })
    assert.equal(proof.status, 'reauthenticated')
    assert.equal(called, 0)
  })

  test('acceptLink is not called for registration', async ({ assert }) => {
    let called = 0
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'application' },
      socialAuthentication: {
        providers: { google: provider('registered-subject', 'registered@example.test', true) },
        acceptLink: async () => {
          called++
          throw new SocialLinkRefusedError()
        },
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
    if (!('continuation' in pending) || !pending.continuation)
      throw new Error('Expected continuation')
    const completed = await account.socialAuthentication.completeRegistration({
      continuation: pending.continuation,
      admit: async () => {},
    })
    assert.equal(completed.status, 'new')
    assert.equal(called, 0)
  })

  test('rejects an acceptLink that is not a function', async ({ assert }) => {
    assert.throws(
      () =>
        makeService(kit, {
          enabled: ['socialAuthentication', 'emailVerification'],
          registration: { availability: 'open' },
          socialAuthentication: {
            providers: { google: provider('invalid-subject', null, false) },
            acceptLink: 'yes' as unknown as AcceptLink,
          },
          authentication: { strategy: 'session', guard: 'web' },
        }),
      'account_kit: socialAuthentication.acceptLink must be a function'
    )
  })
})
