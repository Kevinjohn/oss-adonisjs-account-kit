import { test } from '@japa/runner'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import { CapabilityDisabledError } from '../src/errors.js'
import { capabilities, capabilityRegistry, defaultCapabilities } from '../src/capabilities.js'
import type { AccountKitConfig, Capability } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'

test.group('capability configuration', (group) => {
  const kit = useTestApp(group)

  test('classifies delivery explicitly without changing custom callbacks', ({ assert }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    assert.equal(defineConfig(base).delivery, 'best-effort')
    assert.equal(defineConfig({ ...base, delivery: 'durable' }).delivery, 'durable')
    assert.strictEqual(
      defineConfig({ ...base, delivery: 'durable' }).notify.passwordChanged,
      base.notify.passwordChanged
    )
    assert.throws(() => defineConfig({ ...base, delivery: 'unknown' as never }), /delivery/)
  })

  test('accepts a password-reset-only configuration without unrelated callbacks', ({ assert }) => {
    const input: AccountKitConfig = {
      users: makeUsersAdapter(kit.db, kit.hash),
      enabled: ['passwordReset'],
      registration: { availability: 'open' },
      urls: { passwordReset: (token) => `https://example.test/recovery/${token}` },
      notify: {
        passwordResetProvision: async () => {},
        passwordResetCompleted: async () => {},
      },
      limiterSecret: 'test_only_shared_limiter_secret_32_bytes',
    }

    const resolved = defineConfig(input)
    assert.deepEqual(resolved.enabled, ['passwordReset'])
    assert.isFunction(resolved.urls.passwordReset)
    assert.isFunction(resolved.notify.passwordResetProvision)
    assert.isFunction(resolved.notify.passwordResetCompleted)
    assert.isFunction(resolved.urls.invitation)
    assert.isFunction(resolved.authorize.invite)
    assert.isFunction(resolved.onInvitationAccepted)
  })

  test('accepts an email-verification-only adapter without setEmail', ({ assert }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const config = makeConfig({
      enabled: ['emailVerification'],
      users: { ...users, setEmail: undefined } as never,
    })
    assert.deepEqual(defineConfig(config).enabled, ['emailVerification'])
  })

  test('rejects verification configuration without password replacement', ({ assert }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const config = makeConfig({
      enabled: ['emailVerification'],
      users: { ...users, setPassword: undefined } as never,
    })
    assert.throws(() => defineConfig(config), 'users.setPassword must be a function')
  })

  test('email management requires activation delivery for inactive address replacement', ({
    assert,
  }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    assert.throws(
      () => defineConfig({ ...base, enabled: ['emailPasswordManagement'] }),
      /emailPasswordManagement requires emailVerification/
    )
    assert.throws(
      () =>
        defineConfig({
          ...base,
          enabled: ['emailPasswordManagement', 'emailVerification'],
          urls: { ...base.urls, emailVerification: undefined },
        }),
      /urls\.emailVerification must be a function/
    )
    assert.throws(
      () =>
        defineConfig({
          ...base,
          enabled: ['emailPasswordManagement', 'emailVerification'],
          notify: { ...base.notify, accountActivationProvision: undefined },
        }),
      /notify\.accountActivationProvision must be a function/
    )
  })

  test('validates enabled capability names, duplicates, and required dependencies', ({
    assert,
  }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const base = makeConfig({ users })
    assert.deepEqual(
      defineConfig({ ...base, enabled: ['emailPasswordManagement', 'emailVerification'] }).enabled,
      ['emailPasswordManagement', 'emailVerification']
    )
    assert.throws(
      () => defineConfig({ ...base, enabled: ['passwordReset', 'passwordReset'] }),
      /enabled/
    )
    assert.throws(() => defineConfig({ ...base, enabled: ['unknown'] as never }), /enabled/)

    assert.throws(
      () => defineConfig({ ...base, enabled: ['passwordReset'], urls: {} }),
      /urls\.passwordReset must be a function/
    )
    assert.throws(
      () =>
        defineConfig({
          ...base,
          enabled: ['passwordReset'],
          notify: { ...base.notify, passwordResetProvision: undefined },
        }),
      /notify\.passwordResetProvision must be a function/
    )
    assert.throws(
      () =>
        defineConfig({
          ...base,
          enabled: ['passwordReset'],
          notify: { ...base.notify, passwordResetCompleted: undefined },
        }),
      /notify\.passwordResetCompleted must be a function/
    )
    assert.throws(
      () =>
        defineConfig({
          ...base,
          enabled: ['invitations'],
          authorize: { ...base.authorize, manageInvitation: undefined },
        }),
      /authorize\.manageInvitation must be a function/
    )
    assert.throws(
      () =>
        defineConfig({
          ...base,
          enabled: ['emailVerification'],
          users: { ...users, markEmailVerified: undefined } as never,
        }),
      /users\.markEmailVerified must be a function/
    )
    assert.throws(
      () =>
        defineConfig({
          ...base,
          enabled: ['invitations'],
          users: { ...users, markEmailVerified: undefined } as never,
        }),
      /users\.markEmailVerified must be a function/
    )
  })

  for (const capability of ['passwordReset', 'emailPasswordManagement'] as const) {
    test(`${capability} requires a pending-email setter`, ({ assert }) => {
      const users = makeUsersAdapter(kit.db, kit.hash)
      assert.throws(
        () =>
          defineConfig({
            ...makeConfig({ users }),
            enabled:
              capability === 'emailPasswordManagement'
                ? [capability, 'emailVerification']
                : [capability],
            users: { ...users, setUnverifiedEmail: undefined } as never,
          }),
        /users\.setUnverifiedEmail must be a function/
      )
    })
  }

  test('requires supplied hooks to be callable but does not execute placeholders', ({ assert }) => {
    const base = makeConfig({
      users: makeUsersAdapter(kit.db, kit.hash),
      enabled: ['passwordReset'],
    })
    assert.throws(
      () => defineConfig({ ...base, onLifecycleEvent: 'not callable' } as never),
      /onLifecycleEvent must be a function/
    )

    const setupError = new Error('implement onInvitationAccepted')
    const resolved = defineConfig({
      ...base,
      onInvitationAccepted: async () => {
        throw setupError
      },
    })
    assert.isFunction(resolved.onInvitationAccepted)
  })

  test('validates limiter secret, all budgets, and exclusive revocation hooks', ({ assert }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    assert.throws(() => defineConfig({ ...base, limiterSecret: 'short' }), /limiterSecret/)
    assert.throws(() => defineConfig({ ...base, limiterSecret: 'é'.repeat(15) }), /limiterSecret/)
    assert.throws(() => defineConfig({ ...base, throttle: { requests: 0 } }), /throttle\.requests/)
    assert.throws(
      () => defineConfig({ ...base, throttle: { duration: '0s' } }),
      /throttle\.duration/
    )
    assert.throws(
      () =>
        defineConfig({
          ...base,
          invitationThrottle: { resendInvitation: { requests: -1, duration: '1h' } },
        }),
      /invitationThrottle\.resendInvitation\.requests/
    )
    assert.throws(
      () =>
        defineConfig({
          ...base,
          invitationThrottle: { sendRecipient: { requests: 1, duration: 'soon' } },
        }),
      /invitationThrottle\.sendRecipient\.duration/
    )
    assert.throws(
      () => defineConfig({ ...base, onPasswordResetIssuedTransaction: 'invalid' } as never),
      /onPasswordResetIssuedTransaction must be a function/
    )
    assert.throws(
      () =>
        defineConfig({
          ...base,
          onCredentialsChanged: async () => {},
          onCredentialsChangedTransaction: async () => {},
        }),
      /mutually exclusive/
    )
  })

  test('rejects every disabled operation before adapter, database, or notification work', async ({
    assert,
  }) => {
    let adapterCalls = 0
    let notificationCalls = 0
    const adapter = makeUsersAdapter(kit.db, kit.hash)
    const fail = async () => {
      adapterCalls++
      throw new Error('disabled operation reached the adapter')
    }
    const users = Object.fromEntries(
      Object.keys(adapter).map((key) => [key, fail])
    ) as unknown as typeof adapter
    const callbacks = {
      passwordResetProvision: fail,
      accountActivationProvision: fail,
      invitationProvision: fail,
      emailChangeProvision: fail,
      emailChanged: fail,
      passwordResetCompleted: fail,
      passwordChanged: fail,
    }
    const countNotify = async () => {
      notificationCalls++
    }
    const config = defineConfig({
      ...makeConfig({ users, enabled: [] }),
      notify: Object.fromEntries(Object.keys(callbacks).map((key) => [key, countNotify])) as never,
    })
    const account = new AccountKit({
      config,
      db: kit.db,
      encryption: kit.encryption,
      limiter: kit.limiter,
    })
    const knex = kit.db.connection().getWriteClient()
    let queryCount = 0
    const onQuery = () => queryCount++
    knex.on('query', onQuery)
    const operations: Array<() => Promise<unknown>> = [
      () => account.passwordReset.request({ email: '', clientKey: '' }),
      () => account.passwordReset.inspect({ token: '' }),
      () => account.passwordReset.reset({ token: '', password: '' }),
      () => account.emailVerification.send({ userId: 0 }),
      () => account.emailVerification.complete({ token: '', password: 'NewPassword123' }),
      () => account.invitations.send({ actorId: 0, email: '', role: '' }),
      () => account.invitations.list({ actorId: 0 }),
      () => account.invitations.inspect({ token: '' }),
      () => account.invitations.accept({ token: '', password: '' }),
      () => account.invitations.resend({ actorId: 0, invitationId: 0 }),
      () => account.invitations.revoke({ actorId: 0, invitationId: 0 }),
      () =>
        account.emailPasswordManagement.changePassword({
          actorId: 0,
          currentPassword: '',
          newPassword: '',
        }),
      () =>
        account.emailPasswordManagement.requestEmailChange({
          actorId: 0,
          currentPassword: '',
          newEmail: '',
        }),
      () => account.emailPasswordManagement.completeEmailChange({ token: '' }),
    ]
    try {
      for (const operation of operations) {
        await assert.rejects(operation, CapabilityDisabledError)
      }
    } finally {
      knex.off('query', onQuery)
    }
    assert.equal(adapterCalls, 0)
    assert.equal(notificationCalls, 0)
    assert.equal(queryCount, 0)
  })
})

test.group('capability registry', () => {
  test('has one entry per Capability union member', ({ assert }) => {
    // Record<Capability, true> fails to compile when the union gains or loses a member.
    const union: Record<Capability, true> = {
      passwordReset: true,
      emailVerification: true,
      invitations: true,
      emailPasswordManagement: true,
      registration: true,
      socialAuthentication: true,
      magicLinkLogin: true,
    }
    assert.sameMembers(Object.keys(capabilityRegistry), Object.keys(union))
    assert.deepEqual(capabilities, Object.keys(union) as Capability[])
    assert.deepEqual(defaultCapabilities, [
      'passwordReset',
      'emailVerification',
      'emailPasswordManagement',
    ])
  })
})
