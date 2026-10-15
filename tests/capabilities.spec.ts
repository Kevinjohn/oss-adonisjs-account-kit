import { test } from '@japa/runner'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import { CapabilityDisabledError } from '../src/errors.js'
import type { AccountKitConfig } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'

test.group('capability configuration', (group) => {
  const kit = useTestApp(group)

  test('accepts a recovery-only configuration without unrelated callbacks', ({ assert }) => {
    const input: AccountKitConfig = {
      users: makeUsersAdapter(kit.db, kit.hash),
      enabled: ['recovery'],
      urls: { recovery: (token) => `https://example.test/recovery/${token}` },
      notify: {
        recovery: async () => {},
        passwordReset: async () => {},
      },
      limiterSecret: 'test_only_shared_limiter_secret_32_bytes',
    }

    const resolved = defineConfig(input)
    assert.deepEqual(resolved.enabled, ['recovery'])
    assert.isFunction(resolved.urls.recovery)
    assert.isFunction(resolved.notify.recovery)
    assert.isFunction(resolved.notify.passwordReset)
    assert.isFunction(resolved.urls.invitation)
    assert.isFunction(resolved.authorize.invite)
    assert.isFunction(resolved.onInvitationAccepted)
  })

  test('validates enabled capability names, duplicates, and required dependencies', ({
    assert,
  }) => {
    const users = makeUsersAdapter(kit.db, kit.hash)
    const base = makeConfig({ users })
    assert.deepEqual(defineConfig({ ...base, enabled: ['credentials', 'verification'] }).enabled, [
      'credentials',
      'verification',
    ])
    assert.throws(() => defineConfig({ ...base, enabled: ['recovery', 'recovery'] }), /enabled/)
    assert.throws(() => defineConfig({ ...base, enabled: ['unknown'] as never }), /enabled/)

    assert.throws(
      () => defineConfig({ ...base, enabled: ['recovery'], urls: {} }),
      /urls\.recovery must be a function/
    )
    assert.throws(
      () =>
        defineConfig({
          ...base,
          enabled: ['recovery'],
          notify: { ...base.notify, passwordReset: undefined },
        }),
      /notify\.passwordReset must be a function/
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
          enabled: ['verification'],
          users: { ...users, markEmailVerified: undefined } as never,
        }),
      /users\.markEmailVerified must be a function/
    )
  })

  test('requires supplied hooks to be callable but does not execute placeholders', ({ assert }) => {
    const base = makeConfig({ users: makeUsersAdapter(kit.db, kit.hash), enabled: ['recovery'] })
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
      () => defineConfig({ ...base, onRecoveryIssuedTransaction: 'invalid' } as never),
      /onRecoveryIssuedTransaction must be a function/
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
      recovery: fail,
      verification: fail,
      invitation: fail,
      emailChangeConfirm: fail,
      emailChanged: fail,
      passwordReset: fail,
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
      () => account.recovery.request({ email: '', clientKey: '' }),
      () => account.recovery.inspect({ token: '' }),
      () => account.recovery.reset({ token: '', password: '' }),
      () => account.verification.send({ userId: 0 }),
      () => account.verification.complete({ token: '' }),
      () => account.invitations.send({ actorId: 0, email: '', role: '' }),
      () => account.invitations.list({ actorId: 0 }),
      () => account.invitations.inspect({ token: '' }),
      () => account.invitations.accept({ token: '', password: '' }),
      () => account.invitations.resend({ actorId: 0, invitationId: 0 }),
      () => account.invitations.revoke({ actorId: 0, invitationId: 0 }),
      () =>
        account.credentials.changePassword({ actorId: 0, currentPassword: '', newPassword: '' }),
      () =>
        account.credentials.requestEmailChange({ actorId: 0, currentPassword: '', newEmail: '' }),
      () => account.credentials.completeEmailChange({ token: '' }),
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
