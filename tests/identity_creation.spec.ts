import { test } from '@japa/runner'
import { createLucidAdapter } from '../adapters/lucid.js'
import { consumeUserToken, transaction } from '../src/db.js'
import LucidUser from './fixtures/lucid_user.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService, tokenFrom } from './helpers/fakes.js'
import { InvalidTokenError } from '../src/errors.js'

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
    assert.equal(await account.emailVerification.complete({ token }), 'verified')
    await assert.rejects(() => account.emailVerification.complete({ token }), InvalidTokenError)
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
      () => account.emailVerification.complete({ token: oldProof }),
      InvalidTokenError
    )
    const newProof = tokenFrom(recorder.calls.at(-1)!.args[2])
    await assert.rejects(
      () => account.emailVerification.complete({ token: newProof }),
      InvalidTokenError
    )
    const changed = await account.emailPasswordManagement.completeEmailChange({ token: newProof })
    assert.equal(changed.email, 'next@example.test')
    assert.isNull(changed.unverifiedEmail)
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
      () => account.emailVerification.complete({ token: proof }),
      InvalidTokenError
    )
    const changed = await account.emailPasswordManagement.completeEmailChange({ token: proof })
    assert.equal(changed.email, 'next@example.test')
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
      kit.db.table('social_identities').insert({ ...row, user_id: second.id })
    )
    await kit.db.from('users').where('id', first.id).delete()
    assert.lengthOf(await kit.db.from('social_identities'), 0)
  })
})
