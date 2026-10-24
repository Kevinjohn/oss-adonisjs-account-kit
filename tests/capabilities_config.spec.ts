import { test } from '@japa/runner'
import { Secret } from '@adonisjs/core/helpers'
import { defineConfig } from '../src/account_kit.js'
import type { AccountKitConfig } from '../src/types.js'
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

  test('accepts an AdonisJS Secret for limiterSecret and resolves it to its value', ({
    assert,
  }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    const value = 'a-shared-limiter-secret-of-at-least-32-bytes'
    const resolved = defineConfig({ ...base, limiterSecret: new Secret(value) })
    assert.strictEqual(resolved.limiterSecret, value)
  })

  test('validates limiter secret, all budgets, and exclusive revocation hooks', ({ assert }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash) })
    assert.throws(() => defineConfig({ ...base, limiterSecret: 'short' }), /limiterSecret/)
    assert.throws(() => defineConfig({ ...base, limiterSecret: 'é'.repeat(15) }), /limiterSecret/)
    assert.throws(
      () => defineConfig({ ...base, limiterSecret: new Secret('short') }),
      /limiterSecret/
    )
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
      () => defineConfig({ ...base, onSessionsRevokedTransaction: 'invalid' } as never),
      /onSessionsRevokedTransaction must be a function/
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
})
