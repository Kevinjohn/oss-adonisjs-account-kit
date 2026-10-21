import { test } from '@japa/runner'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import { CapabilityDisabledError } from '../src/errors.js'
import { capabilities, capabilityRegistry, defaultCapabilities } from '../src/capabilities.js'
import type { Capability } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'

test.group('capability configuration', (group) => {
  const kit = useTestApp(group)

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
      sessionManagement: true,
      dataExport: true,
      accountDeletion: true,
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
