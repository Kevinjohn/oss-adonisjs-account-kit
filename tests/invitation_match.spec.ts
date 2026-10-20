/* eslint-disable @unicorn/no-await-expression-member -- Keep each assertion next to the operation it inspects. */

import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { InvalidTokenError } from '../src/errors.js'
import type { AccountKitConfig, LifecycleEvent } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { dbTime } from './helpers/db_time.js'
import { insertUser, makeService, tokenFrom } from './helpers/fakes.js'
import { clientChallenge, provider } from './helpers/social_identity.js'

test.group('invitation match', (group) => {
  const kit = useTestApp(group)

  /** A service with invitations and social sign-in, recording callbacks and lifecycle events. */
  function setup(
    profile: { email: string; verified: boolean },
    overrides: Partial<AccountKitConfig> = {}
  ) {
    const accepted: Array<{ userId: unknown; role: string | undefined; inTransaction: boolean }> =
      []
    const events: LifecycleEvent[] = []
    const service = makeService(kit, {
      enabled: [
        'socialAuthentication',
        'emailVerification',
        'invitations',
        'registration',
        'emailPasswordManagement',
      ],
      registration: { availability: 'open' },
      socialAuthentication: {
        providers: { google: provider('subject-1', profile.email, profile.verified) },
      },
      authentication: { strategy: 'session', guard: 'web' },
      minRequestMs: 0,
      onInvitationAccepted: async (user, invitation, trx) => {
        // Inside the transaction: the new account is visible through trx and the invitation is gone.
        const row = await trx.from('users').where('id', user.id).first()
        const left = await trx.from('account_invitations').where('email', user.email)
        accepted.push({
          userId: user.id,
          role: invitation.role,
          inTransaction: row !== undefined && left.length === 0,
        })
      },
      onLifecycleEvent: async (event) => {
        if (event.type === 'invitation.accepted')
          // After commit: the consume is visible outside the transaction.
          assert(
            (await kit.db.from('account_invitations').where('id', event.invitationId)).length === 0
          )
        events.push(event)
      },
      ...overrides,
    })
    return { ...service, accepted, events }
  }

  function assert(condition: boolean): asserts condition {
    if (!condition) throw new Error('Expected the invitation to be consumed before the event')
  }

  async function invite(
    service: ReturnType<typeof setup>,
    email = 'person@example.test',
    role = 'admin'
  ) {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const invitation = await service.account.invitations.send({ actorId: actor.id, email, role })
    const token = tokenFrom(service.recorder.calls.at(-1)!.args[1])
    return { invitation, token }
  }

  async function socialSignIn(service: ReturnType<typeof setup>) {
    const start = await service.account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    return service.account.socialAuthentication.callback({ state: start.state, callback: {} })
  }

  async function reset() {
    await kit.db.from('account_invitations').delete()
    await kit.db.from('social_transactions').delete()
    await kit.db.from('social_identities').delete()
    await kit.db.from('users').delete()
  }

  const invitationCount = async () => (await kit.db.from('account_invitations')).length
  const accepted = (events: LifecycleEvent[]) =>
    events.filter((event) => event.type === 'invitation.accepted')

  function activationToken(service: ReturnType<typeof setup>) {
    const sent = service.recorder.calls.findLast(
      (call) => call.method === 'accountActivationProvision'
    )
    if (!sent) throw new Error('Expected an activation proof')
    return tokenFrom(sent.args[1])
  }

  test('a new social account with the verified invited address consumes the invitation', async ({
    assert: check,
  }) => {
    const service = setup({ email: 'Person@Example.test', verified: true })
    const { invitation, token } = await invite(service)
    const result = await socialSignIn(service)
    check.equal(result.status, 'new')
    if (result.status !== 'new' || !('userId' in result)) throw new Error('Expected an account')
    check.deepEqual(service.accepted, [
      { userId: result.userId, role: 'admin', inTransaction: true },
    ])
    check.equal(await invitationCount(), 0)
    check.deepEqual(
      accepted(service.events).map((event) => [event.invitationId, event.userId]),
      [[invitation.id, result.userId]]
    )
    await check.rejects(
      () => service.account.invitations.accept({ token, password: 'newPassword123' }),
      InvalidTokenError
    )
  })

  test('a different, expired or unverified address changes nothing and still creates the account', async ({
    assert: check,
  }) => {
    const other = setup({ email: 'other@example.test', verified: true })
    await invite(other)
    check.equal((await socialSignIn(other)).status, 'new')
    check.lengthOf(other.accepted, 0)
    check.equal(await invitationCount(), 1)
    await reset()

    const expired = setup({ email: 'person@example.test', verified: true })
    await invite(expired)
    await kit.db
      .from('account_invitations')
      .update({ expires_at: dbTime(kit, DateTime.utc().minus({ minutes: 1 })) })
    check.equal((await socialSignIn(expired)).status, 'new')
    check.lengthOf(expired.accepted, 0)
    check.equal(await invitationCount(), 1)
    check.lengthOf(accepted(expired.events), 0)
    await reset()

    const unverified = setup({ email: 'person@example.test', verified: false })
    await invite(unverified)
    const result = await socialSignIn(unverified)
    check.deepEqual(result, { status: 'new', emailVerificationRequired: true })
    check.lengthOf(unverified.accepted, 0)
    check.equal(await invitationCount(), 1)
    // Activation then confirms the address, and picks the invitation up.
    await unverified.account.emailVerification.complete({
      token: activationToken(unverified),
      password: 'newPassword123',
    })
    check.lengthOf(unverified.accepted, 1)
    check.equal(await invitationCount(), 0)
    check.lengthOf(accepted(unverified.events), 1)
  })

  test('a throwing callback rolls the account back and keeps the invitation', async ({
    assert: check,
  }) => {
    const service = setup(
      { email: 'person@example.test', verified: true },
      {
        onInvitationAccepted: async () => {
          throw new Error('role service down')
        },
      }
    )
    await invite(service)
    await check.rejects(() => socialSignIn(service), 'role service down')
    check.equal(await invitationCount(), 1)
    check.lengthOf(await kit.db.from('users').where('email', 'person@example.test'), 0)
    check.lengthOf(await kit.db.from('social_identities'), 0)
  })

  test('activation of a password registration consumes the invitation', async ({
    assert: check,
  }) => {
    const service = setup({ email: 'unused@example.test', verified: true })
    const { invitation } = await invite(service)
    const user = await service.account.registration.register({
      email: 'person@example.test',
      password: 'newPassword123',
    })
    check.lengthOf(service.accepted, 0)
    check.equal(await invitationCount(), 1)
    await service.account.emailVerification.complete({
      token: activationToken(service),
      password: 'newPassword123',
    })
    check.deepEqual(service.accepted, [{ userId: user.id, role: 'admin', inTransaction: true }])
    check.equal(await invitationCount(), 0)
    check.deepEqual(
      accepted(service.events).map((event) => [event.invitationId, event.userId]),
      [[invitation.id, user.id]]
    )
  })

  test('a password reset that confirms a never-confirmed account consumes the invitation', async ({
    assert: check,
  }) => {
    const service = setup(
      { email: 'unused@example.test', verified: true },
      {
        enabled: [
          'emailVerification',
          'invitations',
          'registration',
          'emailPasswordManagement',
          'passwordReset',
        ],
      }
    )
    const { invitation } = await invite(service)
    const user = await service.account.registration.register({
      email: 'person@example.test',
      password: 'newPassword123',
    })
    await service.account.passwordReset.request({
      email: 'person@example.test',
      clientKey: 'client',
    })
    const sent = service.recorder.calls.findLast((call) => call.method === 'passwordResetProvision')
    check.equal(await invitationCount(), 1)
    await service.account.passwordReset.reset({
      token: tokenFrom(sent!.args[1]),
      password: 'resetPassword123',
    })
    check.deepEqual(service.accepted, [{ userId: user.id, role: 'admin', inTransaction: true }])
    check.equal(await invitationCount(), 0)
    check.deepEqual(
      accepted(service.events).map((event) => [event.invitationId, event.userId]),
      [[invitation.id, user.id]]
    )
  })

  test('a completed registration continuation and a social confirmation also match', async ({
    assert: check,
  }) => {
    const continued = setup(
      { email: 'person@example.test', verified: true },
      { registration: { availability: 'application' } }
    )
    await invite(continued)
    const start = await socialSignIn(continued)
    if (start.status !== 'new' || !('continuation' in start))
      throw new Error('Expected continuation')
    const finished = await continued.account.socialAuthentication.completeRegistration({
      continuation: start.continuation,
      admit: async () => {},
    })
    if (finished.status !== 'new' || !('userId' in finished)) throw new Error('Expected an account')
    check.equal(await invitationCount(), 0)
    check.deepEqual(
      accepted(continued.events).map((event) => event.userId),
      [finished.userId]
    )
    await reset()

    const confirmed = setup({ email: 'person@example.test', verified: false })
    await invite(confirmed)
    check.equal((await socialSignIn(confirmed)).status, 'new')
    const confirm = await confirmed.account.socialAuthentication.beginConfirmation({
      provider: 'google',
      verificationToken: activationToken(confirmed),
      clientChallenge,
    })
    const linked = await confirmed.account.socialAuthentication.callback({
      state: confirm.state,
      callback: {},
    })
    if (linked.status !== 'linked') throw new Error('Expected a confirmed account')
    check.equal(await invitationCount(), 0)
    check.deepEqual(
      accepted(confirmed.events).map((event) => event.userId),
      [linked.userId]
    )
  })

  test('email change confirmation to an invited address does not match', async ({
    assert: check,
  }) => {
    const service = setup({ email: 'unused@example.test', verified: true })
    await invite(service, 'invited@example.test')
    const user = await insertUser(kit, { email: 'owner@example.test', password: 'oldPassword123' })
    await service.account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newEmail: 'invited@example.test',
    })
    const token = tokenFrom(service.recorder.calls.at(-1)!.args[2])
    const changed = await service.account.emailPasswordManagement.completeEmailChange({ token })
    check.equal(changed.email, 'invited@example.test')
    check.lengthOf(service.accepted, 0)
    check.equal(await invitationCount(), 1)
  })

  test('nothing matches when the invitations capability is disabled', async ({ assert: check }) => {
    const service = setup({ email: 'person@example.test', verified: true })
    await invite(service)
    const disabled = setup(
      { email: 'person@example.test', verified: true },
      { enabled: ['socialAuthentication', 'emailVerification'], onInvitationAccepted: undefined }
    )
    check.equal((await socialSignIn(disabled)).status, 'new')
    check.equal(await invitationCount(), 1)
  })
})
