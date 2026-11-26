import {
  E_ACCOUNT_KIT_CAPABILITY_DISABLED,
  E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED,
  E_ACCOUNT_KIT_INVALID_TOKEN,
  E_ACCOUNT_KIT_THROTTLED,
  E_ACCOUNT_KIT_USER_NOT_FOUND,
} from '../src/errors.ts'
import { test } from '@japa/runner'
import type { LifecycleNotification } from '../src/types.ts'
import { useTestApp } from './helpers/app.ts'
import { denyAll, insertUser, makeService, tokenFrom } from './helpers/fakes.ts'

test.group('operator services', (group) => {
  const kit = useTestApp(group)

  test('operator invite skips actor authorisation and throttles, and sends by default', async ({
    assert,
  }) => {
    const events: LifecycleNotification[] = []
    const { account, recorder } = makeService(kit, {
      authorize: denyAll,
      invitationThrottle: { sendRecipient: { requests: 1, duration: '1h' } },
      onLifecycleNotification: async (event) => {
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
      events.map((event) => ({
        type: event.type,
        source: 'source' in event ? event.source : undefined,
      })),
      [
        { type: 'invitation.sent', source: 'operator' },
        { type: 'invitation.sent', source: 'operator' },
      ]
    )
  })

  test('operator invite replaces only a pending invitation in the same scope', async ({
    assert,
  }) => {
    const { account, recorder } = makeService(kit)
    const first = await account.operator.invite({
      email: 'boss@example.test',
      role: 'admin',
      scope: 'team-a',
      deliver: 'print',
    })
    const second = await account.operator.invite({
      email: 'boss@example.test',
      role: 'owner',
      scope: 'team-a',
      deliver: 'print',
    })
    const otherScope = await account.operator.invite({
      email: 'boss@example.test',
      role: 'member',
      scope: 'team-b',
      deliver: 'print',
    })
    assert.lengthOf(recorder.calls, 0)
    assert.notEqual(first.url, second.url)
    const invitations = await kit.db
      .from('account_invitations')
      .where('email', 'boss@example.test')
      .orderBy('scope')
    assert.lengthOf(invitations, 2)
    assert.deepEqual(
      invitations.map(({ scope, role }) => ({ scope, role })),
      [
        { scope: 'team-a', role: 'owner' },
        { scope: 'team-b', role: 'member' },
      ]
    )
    assert.isNull(await account.invitations.inspect({ token: tokenFrom(first.url) }))
    assert.deepEqual(await account.invitations.inspect({ token: tokenFrom(second.url) }), {
      email: 'boss@example.test',
      role: 'owner',
    })
    assert.deepEqual(await account.invitations.inspect({ token: tokenFrom(otherScope.url) }), {
      email: 'boss@example.test',
      role: 'member',
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
      E_ACCOUNT_KIT_INVALID_TOKEN
    )
  })

  test('operator invite rejects existing accounts, bad input and a disabled capability', async ({
    assert,
  }) => {
    await insertUser(kit, { email: 'taken@example.test' })
    const { account } = makeService(kit)
    await assert.rejects(
      () => account.operator.invite({ email: 'taken@example.test', role: 'a', deliver: 'send' }),
      E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED
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
      E_ACCOUNT_KIT_CAPABILITY_DISABLED
    )
  })

  test('a failed follow-up returns the printed link with a safe fault', async ({ assert }) => {
    const { account } = makeService(kit, {
      onLifecycleNotification: async () => {
        throw new Error('observer failed at https://secret.example/token')
      },
    })
    const result = await account.operator.invite({
      email: 'late@example.test',
      role: 'admin',
      deliver: 'print',
    })
    assert.isString(result.url)
    assert.equal(result.fault?.name, 'PostCommitException')
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
      E_ACCOUNT_KIT_THROTTLED
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
    const events: LifecycleNotification[] = []
    const { account, recorder } = makeService(kit, {
      onLifecycleNotification: async (event) => {
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

  for (const deliver of ['print', 'send'] as const) {
    test(`operator reset ${deliver} preserves the live proof when URL construction fails`, async ({
      assert,
    }) => {
      await insertUser(kit)
      const failure = new Error('Reset URL unavailable')
      let fail = false
      let issued = 0
      const events: LifecycleNotification[] = []
      const { account, recorder } = makeService(kit, {
        enabled: ['passwordReset'],
        urls: {
          passwordReset(token) {
            if (fail) throw failure
            return `https://example.test/recovery/${token}`
          },
        },
        onPasswordResetIssuedTransaction: async () => {
          issued++
        },
        onLifecycleNotification: async (event) => {
          events.push(event)
        },
      })
      const first = await account.operator.resetLink({
        email: 'person@example.test',
        deliver: 'print',
      })
      const before = await kit.db.from('password_reset_tokens')
      fail = true
      const thrown = await account.operator
        .resetLink({ email: 'person@example.test', deliver })
        .catch((error) => error)
      assert.strictEqual(thrown, failure)
      assert.deepEqual(await kit.db.from('password_reset_tokens'), before)
      assert.isTrue(await account.passwordReset.inspect({ token: tokenFrom(first.url) }))
      assert.equal(issued, 1)
      assert.lengthOf(events, 1)
      assert.lengthOf(recorder.calls, 0)
    })
  }

  test('operator reset skips the URL builder for unknown accounts in both delivery modes', async ({
    assert,
  }) => {
    let calls = 0
    const { account, recorder } = makeService(kit, {
      enabled: ['passwordReset'],
      urls: {
        passwordReset() {
          calls++
          throw new Error('URL builder must not run')
        },
      },
    })
    for (const deliver of ['print', 'send'] as const)
      await assert.rejects(
        () => account.operator.resetLink({ email: 'nobody@example.test', deliver }),
        E_ACCOUNT_KIT_USER_NOT_FOUND
      )
    assert.equal(calls, 0)
    assert.lengthOf(recorder.calls, 0)
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 0)
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
      E_ACCOUNT_KIT_USER_NOT_FOUND
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
})
