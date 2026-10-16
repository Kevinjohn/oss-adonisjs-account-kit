import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { createLucidAdapter } from '../adapters/lucid.js'
import { consumeUserToken, transaction } from '../src/db.js'
import LucidUser from './fixtures/lucid_user.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService, makeUsersAdapter, tokenFrom } from './helpers/fakes.js'
import { EmailAlreadyRegisteredError, InvalidTokenError, PostCommitError } from '../src/errors.js'

test.group('identity creation contract', (group) => {
  const kit = useTestApp(group)

  test('creates an inactive account with a pending email and no local password', async ({
    assert,
  }) => {
    const adapter = createLucidAdapter(async () => LucidUser)
    const user = await transaction(kit.db, (trx) =>
      adapter.create(
        {
          email: '  Pending@Example.Test ',
          unverifiedEmail: ' Pending@Example.Test ',
          password: null,
        },
        trx
      )
    )
    assert.equal(user.email, 'pending@example.test')
    assert.equal(user.unverifiedEmail, 'pending@example.test')
    assert.isFalse(user.hasPassword)
    assert.isNull(user.emailVerifiedAt)
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.equal(row.unverified_email, 'pending@example.test')
    assert.isNull(row.password)
  })

  test('stores only a hash and consumes email verification proof once', async ({ assert }) => {
    const user = await insertUser(kit, { verified: false })
    const { account, recorder } = makeService(kit)
    await account.emailVerification.send({ userId: user.id })
    const token = tokenFrom(recorder.calls[0].args[1])
    const row = await kit.db
      .from('email_verification_tokens')
      .where('tokenable_id', user.id)
      .first()
    assert.exists(row)
    assert.notEqual(row.hash, token)
    assert.equal(
      await account.emailVerification.complete({ token, password: 'NewPassword123' }),
      'verified'
    )
    await assert.rejects(
      () => account.emailVerification.complete({ token, password: 'NewPassword123' }),
      InvalidTokenError
    )
  })

  test('a failed activation write rolls back proof consumption and state together', async ({
    assert,
  }) => {
    const user = await insertUser(kit, { verified: false })
    const users = makeUsersAdapter(kit.db, kit.hash)
    const { account, recorder } = makeService(kit, {
      users: {
        ...users,
        markEmailVerified: async () => {
          throw new Error('activation write failed')
        },
      },
    })
    await account.emailVerification.send({ userId: user.id })
    const token = tokenFrom(recorder.calls[0].args[1])
    await assert.rejects(
      () => account.emailVerification.complete({ token, password: 'NewPassword123' }),
      /activation write failed/
    )
    assert.lengthOf(
      await kit.db.from('email_verification_tokens').where('tokenable_id', user.id),
      1
    )
    const pending = await kit.db.from('users').where('id', user.id).first()
    assert.equal(pending.unverified_email, pending.email)
    assert.isNull(pending.email_verified_at)
    assert.equal(
      await makeService(kit).account.emailVerification.complete({
        token,
        password: 'NewPassword123',
      }),
      'verified'
    )
  })

  test('token consumption removes the live proof atomically before account-state writes', async ({
    assert,
  }) => {
    const user = await insertUser(kit, { verified: false })
    const { account, config, recorder } = makeService(kit)
    await account.emailVerification.send({ userId: user.id })
    const token = tokenFrom(recorder.calls[0].args[1])
    await transaction(kit.db, async (trx) => {
      await consumeUserToken(trx, config, 'email_verification_tokens', token, () => true)
      await assert.rejects(
        () => consumeUserToken(trx, config, 'email_verification_tokens', token, () => true),
        InvalidTokenError
      )
    })
  })

  test('inactive email change updates both addresses and supersedes the old proof', async ({
    assert,
  }) => {
    const user = await insertUser(kit, { verified: false })
    const { account, recorder } = makeService(kit)
    await account.emailVerification.send({ userId: user.id })
    const oldProof = tokenFrom(recorder.calls[0].args[1])
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'password123',
      newEmail: 'next@example.test',
    })
    const pending = await kit.db.from('users').where('id', user.id).first()
    assert.equal(pending.email, 'next@example.test')
    assert.equal(pending.unverified_email, 'next@example.test')
    assert.isNull(pending.email_verified_at)
    await assert.rejects(
      () => account.emailVerification.complete({ token: oldProof, password: 'NewPassword123' }),
      InvalidTokenError
    )
    const newProof = tokenFrom(recorder.calls.at(-1)!.args[1])
    await assert.rejects(
      () => account.emailPasswordManagement.completeEmailChange({ token: newProof }),
      InvalidTokenError
    )
    assert.equal(
      await account.emailVerification.complete({ token: newProof, password: 'NewPassword123' }),
      'verified'
    )
    const changed = await kit.db.from('users').where('id', user.id).first()
    assert.equal(changed.email, 'next@example.test')
    assert.isNull(changed.unverified_email)
  })

  test('inactive email write revokes credentials transactionally and rolls back on callback failure', async ({
    assert,
  }) => {
    const user = await insertUser(kit, { verified: false })
    let called = false
    const { account } = makeService(kit, {
      onCredentialsChangedTransaction: async (_account, context, trx) => {
        called = true
        assert.equal(context.operation, 'email_change')
        const row = await trx.from('users').where('id', user.id).first()
        assert.equal(row.email, 'next@example.test')
        throw new Error('revocation failed')
      },
    })
    await assert.rejects(
      () =>
        account.emailPasswordManagement.requestEmailChange({
          actorId: user.id,
          currentPassword: 'password123',
          newEmail: 'next@example.test',
        }),
      /revocation failed/
    )
    assert.isTrue(called)
    const after = await kit.db.from('users').where('id', user.id).first()
    assert.equal(after.email, user.email)
    assert.equal(after.unverified_email, user.email)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
  })

  test('inactive email write calls the post-commit credential hook with refreshed state', async ({
    assert,
  }) => {
    const user = await insertUser(kit, { verified: false })
    let callbackUser: { email: string; unverifiedEmail: string | null } | undefined
    const { account, recorder } = makeService(kit, {
      onCredentialsChanged: async (current, context) => {
        assert.equal(context.operation, 'email_change')
        const persisted = await kit.db.from('users').where('id', user.id).first()
        assert.equal(persisted.email, 'next@example.test')
        assert.equal(persisted.unverified_email, 'next@example.test')
        callbackUser = current
      },
    })
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'password123',
      newEmail: 'next@example.test',
    })
    assert.equal(callbackUser?.email, 'next@example.test')
    assert.equal(callbackUser?.unverifiedEmail, 'next@example.test')
    const noticeUser = recorder.calls.find((call) => call.method === 'accountActivationProvision')
      ?.args[0] as { email: string; unverifiedEmail: string | null }
    assert.equal(noticeUser.email, 'next@example.test')
    assert.equal(noticeUser.unverifiedEmail, 'next@example.test')
  })

  test('inactive post-commit hook failure still delivers the proof after commit', async ({
    assert,
  }) => {
    const user = await insertUser(kit, { verified: false })
    const { account, recorder } = makeService(kit, {
      onCredentialsChanged: async () => {
        throw new Error('observer failed')
      },
    })
    try {
      await account.emailPasswordManagement.requestEmailChange({
        actorId: user.id,
        currentPassword: 'password123',
        newEmail: 'next@example.test',
      })
      assert.fail('expected committed observer failure')
    } catch (error) {
      assert.instanceOf(error, PostCommitError)
      assert.isTrue((error as PostCommitError).committed)
    }
    assert.deepEqual(
      recorder.calls.map((call) => call.method),
      ['accountActivationProvision']
    )
    const changed = await kit.db.from('users').where('id', user.id).first()
    assert.equal(changed.email, 'next@example.test')
    assert.equal(changed.unverified_email, 'next@example.test')
    assert.lengthOf(
      await kit.db.from('email_verification_tokens').where('tokenable_id', user.id),
      1
    )
  })

  test('active pending change keeps credential callback until proof completion', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const observed: string[] = []
    const { account, recorder } = makeService(kit, {
      onCredentialsChanged: async (current) => {
        observed.push(current.email)
      },
    })
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'password123',
      newEmail: 'next@example.test',
    })
    assert.deepEqual(observed, [])
    const proof = tokenFrom(recorder.calls[0].args[2])
    await account.emailPasswordManagement.completeEmailChange({ token: proof })
    assert.deepEqual(observed, ['next@example.test'])
  })

  test('inactive email write translates a raced unique-address conflict', async ({ assert }) => {
    const user = await insertUser(kit, { verified: false })
    await insertUser(kit, { email: 'taken@example.test' })
    const users = makeUsersAdapter(kit.db, kit.hash)
    const { account } = makeService(kit, {
      users: {
        ...users,
        findByEmail: async (email, trx, options) =>
          email === 'taken@example.test' ? null : users.findByEmail(email, trx, options),
      },
    })
    await assert.rejects(
      () =>
        account.emailPasswordManagement.requestEmailChange({
          actorId: user.id,
          currentPassword: 'password123',
          newEmail: 'taken@example.test',
        }),
      EmailAlreadyRegisteredError
    )
  })

  test('activation resend cannot replace a pending email-change proof', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account, recorder } = makeService(kit)
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'password123',
      newEmail: 'next@example.test',
    })
    const proof = tokenFrom(recorder.calls[0].args[2])
    assert.equal(await account.emailVerification.send({ userId: user.id }), 'already_verified')
    assert.equal(recorder.calls.length, 1)
    await assert.rejects(
      () => account.emailVerification.complete({ token: proof, password: 'NewPassword123' }),
      InvalidTokenError
    )
    const changed = await account.emailPasswordManagement.completeEmailChange({ token: proof })
    assert.equal(changed.email, 'next@example.test')
  })

  test('inactive activation resend suppresses then replaces its pending activation proof', async ({
    assert,
  }) => {
    const user = await insertUser(kit, { verified: false })
    const { account, recorder } = makeService(kit)
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'password123',
      newEmail: 'next@example.test',
    })
    const oldProof = tokenFrom(recorder.calls[0].args[1])
    assert.equal(await account.emailVerification.send({ userId: user.id }), 'sent')
    assert.lengthOf(recorder.calls, 1)
    await kit.db
      .from('email_verification_tokens')
      .where('tokenable_id', user.id)
      .update({
        created_at: DateTime.utc().minus({ minutes: 2 }).toISO(),
      })
    assert.equal(await account.emailVerification.send({ userId: user.id }), 'sent')
    const activationProof = tokenFrom(recorder.calls.at(-1)!.args[1])
    await assert.rejects(
      () => account.emailVerification.complete({ token: oldProof, password: 'NewPassword123' }),
      InvalidTokenError
    )
    assert.equal(
      await account.emailVerification.complete({
        token: activationProof,
        password: 'NewPassword123',
      }),
      'verified'
    )
  })

  test('email-change completion rejects an activation-purpose proof for the pending address', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account, recorder } = makeService(kit)
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'password123',
      newEmail: 'next@example.test',
    })
    const proof = tokenFrom(recorder.calls[0].args[2])
    await kit.db
      .from('email_verification_tokens')
      .where('tokenable_id', user.id)
      .update({ purpose: 'activation' })
    await assert.rejects(
      () => account.emailPasswordManagement.completeEmailChange({ token: proof }),
      InvalidTokenError
    )
    const after = await kit.db.from('users').where('id', user.id).first()
    assert.equal(after.email, user.email)
    assert.equal(after.unverified_email, 'next@example.test')
  })

  test('email-change proof remains bound to the current confirmed address', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account, recorder } = makeService(kit)
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'password123',
      newEmail: 'next@example.test',
    })
    const proof = tokenFrom(recorder.calls[0].args[2])
    await kit.db.from('users').where('id', user.id).update({ email: 'other@example.test' })
    await assert.rejects(
      () => account.emailPasswordManagement.completeEmailChange({ token: proof }),
      InvalidTokenError
    )
  })

  test('cancelling a pending change invalidates its proof while retaining the confirmed email', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account, recorder } = makeService(kit)
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'password123',
      newEmail: 'next@example.test',
    })
    const proof = tokenFrom(recorder.calls[0].args[2])
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'password123',
      newEmail: user.email,
    })
    const after = await kit.db.from('users').where('id', user.id).first()
    assert.equal(after.email, user.email)
    assert.isNull(after.unverified_email)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
    await assert.rejects(
      () => account.emailPasswordManagement.completeEmailChange({ token: proof }),
      InvalidTokenError
    )
  })

  test('password change clears a distinct pending address but keeps an inactive address pending', async ({
    assert,
  }) => {
    const active = await insertUser(kit)
    const inactive = await insertUser(kit, { verified: false, email: 'inactive@example.test' })
    const { account } = makeService(kit)
    await account.emailPasswordManagement.requestEmailChange({
      actorId: active.id,
      currentPassword: 'password123',
      newEmail: 'next@example.test',
    })
    await account.emailPasswordManagement.changePassword({
      actorId: active.id,
      currentPassword: 'password123',
      newPassword: 'newPassword123',
    })
    await account.emailPasswordManagement.changePassword({
      actorId: inactive.id,
      currentPassword: 'password123',
      newPassword: 'newPassword123',
    })
    const activeAfter = await kit.db.from('users').where('id', active.id).first()
    assert.isNull(activeAfter.unverified_email)
    const stillInactive = await kit.db.from('users').where('id', inactive.id).first()
    assert.equal(stillInactive.unverified_email, stillInactive.email)
  })

  test('password reset clears a distinct pending address but activates equal inactive state', async ({
    assert,
  }) => {
    const active = await insertUser(kit)
    const inactive = await insertUser(kit, { verified: false, email: 'inactive@example.test' })
    const { account, recorder } = makeService(kit)
    await account.emailPasswordManagement.requestEmailChange({
      actorId: active.id,
      currentPassword: 'password123',
      newEmail: 'next@example.test',
    })
    await account.passwordReset.request({ email: active.email, clientKey: 'active-client' })
    const activeToken = tokenFrom(recorder.calls.at(-1)!.args[1])
    await account.passwordReset.reset({ token: activeToken, password: 'newPassword123' })
    const activeAfter = await kit.db.from('users').where('id', active.id).first()
    assert.isNull(activeAfter.unverified_email)
    await account.passwordReset.request({ email: inactive.email, clientKey: 'inactive-client' })
    const inactiveToken = tokenFrom(recorder.calls.at(-1)!.args[1])
    await account.passwordReset.reset({ token: inactiveToken, password: 'newPassword123' })
    const inactiveAfter = await kit.db.from('users').where('id', inactive.id).first()
    assert.isNull(inactiveAfter.unverified_email)
  })

  test('social identity relationships enforce subject uniqueness and cascade without credential storage', async ({
    assert,
  }) => {
    const first = await insertUser(kit)
    const second = await insertUser(kit, { email: 'second@example.test' })
    const columns = await kit.db.connection().columnsInfo('social_identities')
    assert.notProperty(columns, 'access_token')
    assert.notProperty(columns, 'refresh_token')
    const row = {
      user_id: first.id,
      provider: 'example',
      provider_user_id: 'subject-1',
      email: 'snapshot@example.test',
      email_verified: true,
      created_at: new Date(),
      updated_at: new Date(),
    }
    await kit.db.table('social_identities').insert(row)
    await assert.rejects(() =>
      kit.db
        .table('social_identities')
        .insert({ ...row, provider_user_id: 'orphan', user_id: 999999 })
    )
    await assert.rejects(() =>
      kit.db.table('social_identities').insert({ ...row, user_id: second.id })
    )
    await kit.db.from('users').where('id', first.id).delete()
    assert.lengthOf(await kit.db.from('social_identities'), 0)
  })
})
