import { test } from '@japa/runner'
import { CapabilityDisabledError, ThrottledError, UserNotFoundError } from '../src/errors.js'
import type { LifecycleEvent } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { denyAll, insertUser, makeService, tokenFrom } from './helpers/fakes.js'

test.group('operator services', (group) => {
  const kit = useTestApp(group)

  test('operator invite skips actor authorisation and throttles, and sends by default', async ({
    assert,
  }) => {
    const events: LifecycleEvent[] = []
    const { account, recorder } = makeService(kit, {
      authorize: denyAll,
      invitationThrottle: { sendRecipient: { requests: 1, duration: '1h' } },
      onLifecycleEvent: async (event) => {
        events.push(event)
      },
    })
    const first = await account.operator.invite({
      email: ' New@Example.test ',
      role: 'admin',
      deliver: 'send',
    })
    assert.equal(first.invitation.email, 'new@example.test')
    assert.isNull(first.invitation.inviterId)
    assert.isUndefined(first.url)
    assert.isUndefined(first.fault)
    assert.deepEqual(
      recorder.calls.map((call) => call.method),
      ['invitationProvision']
    )
    // A second issue for the same address is not blocked by the recipient budget.
    await account.operator.invite({ email: 'new@example.test', role: 'admin', deliver: 'send' })
    assert.deepEqual(
      events.map((event) => ({ type: event.type, source: 'source' in event ? event.source : undefined })),
      [
        { type: 'invitation.sent', source: 'operator' },
        { type: 'invitation.sent', source: 'operator' },
      ]
    )
  })

  test('operator invite replaces a pending invitation and the printed link accepts', async ({
    assert,
  }) => {
    const { account, recorder } = makeService(kit)
    const first = await account.operator.invite({
      email: 'boss@example.test',
      role: 'admin',
      deliver: 'print',
    })
    const second = await account.operator.invite({
      email: 'boss@example.test',
      role: 'owner',
      deliver: 'print',
    })
    assert.lengthOf(recorder.calls, 0)
    assert.notEqual(first.url, second.url)
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
    assert.isNull(await account.invitations.inspect({ token: tokenFrom(first.url) }))
    assert.deepEqual(await account.invitations.inspect({ token: tokenFrom(second.url) }), {
      email: 'boss@example.test',
      role: 'owner',
    })
  })

  test('first-admin bootstrap: zero users, operator invite, acceptance assigns the role', async ({
    assert,
  }) => {
    const assigned: Array<{ userId: unknown; role: string }> = []
    const { account } = makeService(kit, {
      onInvitationAccepted: async (user, invitation, trx) => {
        await trx.from('users').where('id', user.id).update({ disabled_at: null })
        assigned.push({ userId: user.id, role: invitation.role })
      },
    })
    assert.lengthOf(await kit.db.from('users'), 0)
    const { url } = await account.operator.invite({
      email: 'first@example.test',
      role: 'admin',
      deliver: 'print',
    })
    const user = await account.invitations.accept({
      token: tokenFrom(url),
      password: 'first-admin-password',
    })
    assert.deepEqual(assigned, [{ userId: user.id, role: 'admin' }])
    await assert.rejects(
      () => account.invitations.accept({ token: tokenFrom(url), password: 'another-password' }),
      /InvalidTokenError/
    )
  })

  test('operator invite rejects existing accounts, bad input and a disabled capability', async ({
    assert,
  }) => {
    await insertUser(kit, { email: 'taken@example.test' })
    const { account } = makeService(kit)
    await assert.rejects(
      () => account.operator.invite({ email: 'taken@example.test', role: 'a', deliver: 'send' }),
      /EmailAlreadyRegisteredError/
    )
    await assert.rejects(
      () => account.operator.invite({ email: 'not-an-email', role: 'a', deliver: 'send' }),
      /Invalid email/
    )
    await assert.rejects(
      () => account.operator.invite({ email: 'x@example.test', role: '', deliver: 'send' }),
      /Invalid role/
    )
    await assert.rejects(
      () =>
        account.operator.invite({
          email: 'x@example.test',
          role: 'a',
          deliver: 'both' as never,
        }),
      /Invalid delivery/
    )
    const disabled = makeService(kit, { enabled: ['passwordReset'] }).account
    await assert.rejects(
      () => disabled.operator.invite({ email: 'x@example.test', role: 'a', deliver: 'send' }),
      CapabilityDisabledError
    )
  })

  test('a failed follow-up returns the printed link with a safe fault', async ({ assert }) => {
    const { account } = makeService(kit, {
      onLifecycleEvent: async () => {
        throw new Error('observer failed at https://secret.example/token')
      },
    })
    const result = await account.operator.invite({
      email: 'late@example.test',
      role: 'admin',
      deliver: 'print',
    })
    assert.isString(result.url)
    assert.equal(result.fault?.name, 'PostCommitError')
    assert.notInclude(JSON.stringify(result.fault), 'secret.example')
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
  })

  test('operator reset link skips throttles and the public paths still throttle', async ({
    assert,
  }) => {
    await insertUser(kit, { email: 'locked@example.test' })
    const { account, recorder } = makeService(kit, {
      throttle: { requests: 1, duration: '1h' },
    })
    await account.passwordReset.request({ email: 'locked@example.test', clientKey: 'client' })
    await assert.rejects(
      () => account.passwordReset.request({ email: 'locked@example.test', clientKey: 'client' }),
      ThrottledError
    )
    const printed = await account.operator.resetLink({
      email: 'locked@example.test',
      deliver: 'print',
    })
    assert.lengthOf(recorder.calls, 1)
    const user = await account.passwordReset.reset({
      token: tokenFrom(printed.url),
      password: 'brand-new-password',
    })
    assert.equal(user.email, 'locked@example.test')
  })

  test('operator reset link replaces the live token and sends by default', async ({ assert }) => {
    await insertUser(kit, { email: 'person@example.test' })
    const events: LifecycleEvent[] = []
    const { account, recorder } = makeService(kit, {
      onLifecycleEvent: async (event) => {
        events.push(event)
      },
    })
    const printed = await account.operator.resetLink({
      email: 'person@example.test',
      deliver: 'print',
    })
    const sent = await account.operator.resetLink({ email: 'Person@Example.test', deliver: 'send' })
    assert.isUndefined(sent.url)
    assert.equal(recorder.calls.at(-1)?.method, 'passwordResetProvision')
    assert.isFalse(await account.passwordReset.inspect({ token: tokenFrom(printed.url) }))
    assert.isTrue(
      await account.passwordReset.inspect({ token: tokenFrom(recorder.calls.at(-1)?.args[1]) })
    )
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
    assert.deepEqual(
      events.map((event) => event.type === 'password_reset.requested' && event.source),
      ['operator', 'operator']
    )
  })

  test('operator reset link reports unknown accounts and keeps the issuance hook', async ({
    assert,
  }) => {
    const user = await insertUser(kit, { email: 'hooked@example.test' })
    let allow = true
    const hooked: unknown[] = []
    const { account } = makeService(kit, {
      onPasswordResetIssuedTransaction: async (issued) => {
        hooked.push(issued.id)
        if (!allow) throw new Error('application refused')
      },
    })
    await assert.rejects(
      () => account.operator.resetLink({ email: 'nobody@example.test', deliver: 'print' }),
      UserNotFoundError
    )
    const first = await account.operator.resetLink({
      email: 'hooked@example.test',
      deliver: 'print',
    })
    allow = false
    await assert.rejects(
      () => account.operator.resetLink({ email: 'hooked@example.test', deliver: 'print' }),
      /application refused/
    )
    assert.deepEqual(hooked, [user.id, user.id])
    assert.isTrue(await account.passwordReset.inspect({ token: tokenFrom(first.url) }))
  })

  test('public reset still runs the issuance hook after the extraction', async ({ assert }) => {
    await insertUser(kit, { email: 'public@example.test' })
    const hooked: unknown[] = []
    const { account } = makeService(kit, {
      onPasswordResetIssuedTransaction: async (issued) => {
        hooked.push(issued.email)
      },
    })
    await account.passwordReset.request({ email: 'public@example.test', clientKey: 'c' })
    assert.deepEqual(hooked, ['public@example.test'])
  })

  test('public invitation send still authorises and throttles after the extraction', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const denied = makeService(kit, { authorize: denyAll }).account
    await assert.rejects(
      () => denied.invitations.send({ actorId: actor.id, email: 'a@example.test', role: 'x' }),
      /AuthorizationError/
    )
    const { account } = makeService(kit, {
      invitationThrottle: { sendRecipient: { requests: 1, duration: '1h' } },
    })
    await account.invitations.send({ actorId: actor.id, email: 'b@example.test', role: 'x' })
    await assert.rejects(
      () => account.invitations.send({ actorId: actor.id, email: 'b@example.test', role: 'x' }),
      ThrottledError
    )
  })
})
