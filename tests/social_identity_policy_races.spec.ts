import { test } from '@japa/runner'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService } from './helpers/fakes.js'
import { clientChallenge, provider, current } from './helpers/social_identity.js'
import { dbTime } from './helpers/db_time.js'
import { LastLoginMethodError, InvalidSessionError } from '../src/errors.js'
import { readIsoTimestamp } from '../src/timestamps.js'
import { locksRows } from './helpers/dialect.js'
import {
  assertUserLockIsHeld,
  createBarrier,
  startWithBackendId,
  waitForDatabaseLockWait,
} from './helpers/lock_coordination.js'

test.group('social policy and method races', (group) => {
  const kit = useTestApp(group)

  test('closed registration rejects a new subject but keeps a confirmed linked subject usable', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const adapters = { google: provider('known-subject', user.email, true) }
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'closed' },
      socialAuthentication: { providers: adapters },
      authentication: { strategy: 'session', guard: 'web' },
    })
    await kit.db.table('social_identities').insert({
      user_id: user.id,
      provider: 'google',
      provider_user_id: 'known-subject',
      email: user.email,
      email_verified: true,
      confirmed_at: dbTime(kit),
      created_at: dbTime(kit),
      updated_at: dbTime(kit),
    })
    const known = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const linked = await account.socialAuthentication.callback({ state: known.state, callback: {} })
    assert.equal(linked.status, 'linked')
    adapters.google = provider('new-subject', 'new@example.test', true)
    const fresh = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    await assert.rejects(
      () => account.socialAuthentication.callback({ state: fresh.state, callback: {} }),
      'Invalid social transaction'
    )
    assert.lengthOf(await kit.db.from('users'), 1)
  })

  test('one of two last-method unlink attempts succeeds and a confirmed method remains', async ({
    assert,
  }) => {
    const user = await insertUser(kit, { password: null })
    const timestamp = dbTime(kit)
    for (const [providerName, subject] of [
      ['google', 'g-subject'],
      ['github', 'h-subject'],
    ] as const) {
      await kit.db.table('social_identities').insert({
        user_id: user.id,
        provider: providerName,
        provider_user_id: subject,
        email: user.email,
        email_verified: true,
        confirmed_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      })
    }
    const barrier = createBarrier('First social unlink transaction')
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => (releaseFirst = resolve))
    let firstHookCalls = 0
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification'],
      registration: { availability: 'closed' },
      socialAuthentication: {
        providers: {
          google: provider('g-subject', user.email, true),
          github: provider('h-subject', user.email, true),
        },
      },
      authentication: { strategy: 'session', guard: 'web' },
      onCredentialsChangedTransaction: async (_changed, context) => {
        if (context.operation !== 'social_unlink' || firstHookCalls++ !== 0) return
        barrier.signal()
        await firstRelease
      },
    })
    const first = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'reauth',
      current: current(user.id),
      purpose: 'social_unlink',
      clientChallenge,
    })
    const second = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'reauth',
      current: current(user.id),
      purpose: 'social_unlink',
      clientChallenge,
    })
    const firstProof = await account.socialAuthentication.callback({
      state: first.state,
      callback: {},
      current: current(user.id),
    })
    const secondProof = await account.socialAuthentication.callback({
      state: second.state,
      callback: {},
      current: current(user.id),
    })
    if (firstProof.status !== 'reauthenticated' || secondProof.status !== 'reauthenticated')
      throw new Error('Expected proofs')
    const rows = await account.socialAuthentication.list({ current: current(user.id) })
    const google = rows.find((row) => row.provider === 'google')!
    const github = rows.find((row) => row.provider === 'github')!
    const firstTracked = startWithBackendId(kit, () =>
      account.socialAuthentication.unlink({
        current: current(user.id),
        identityId: google.id,
        proof: firstProof.proof,
      })
    )
    const firstOperation = firstTracked.operation
    barrier.observe(firstOperation)
    let secondOperation: Promise<void> | undefined

    try {
      await barrier.promise
      const firstBackendId = await firstTracked.backendId
      assert.isTrue(firstHookCalls === 1)

      const secondTracked = startWithBackendId(kit, () =>
        account.socialAuthentication.unlink({
          current: current(user.id),
          identityId: github.id,
          proof: secondProof.proof,
        })
      )
      secondOperation = secondTracked.operation

      if (locksRows) {
        const secondBackendId = await secondTracked.backendId
        const secondOutcome = secondOperation.then(
          () => ({ kind: 'completed' as const }),
          (error: unknown) => ({ kind: 'failed' as const, error })
        )
        const waiting = waitForDatabaseLockWait(
          kit,
          assert,
          secondBackendId,
          firstBackendId,
          'users'
        ).then(
          () => ({ kind: 'waiting' as const }),
          (error: unknown) => ({ kind: 'wait-failed' as const, error })
        )
        const stage = await Promise.race([waiting, secondOutcome])
        if (stage.kind === 'completed')
          throw new Error('Second unlink completed before the account-lock wait was observed')
        if (stage.kind === 'failed' || stage.kind === 'wait-failed') throw stage.error
      } else {
        // SQLite has no row-lock graph to observe. Confirm the first transaction owns the
        // singleton writer lock, then assert the serialized outcomes after it is released; this
        // branch does not claim that the second unlink reached SQLite's writer lock before release.
        await assertUserLockIsHeld(kit, assert, user.id)
      }
    } finally {
      releaseFirst()
      await Promise.all([firstOperation.catch(() => {}), secondOperation?.catch(() => {})])
    }

    const [firstOutcome, secondOutcome] = await Promise.allSettled([
      firstOperation,
      secondOperation!,
    ])
    assert.equal(firstOutcome.status, 'fulfilled')
    assert.equal(secondOutcome.status, 'rejected')
    assert.instanceOf((secondOutcome as PromiseRejectedResult).reason, InvalidSessionError)

    const after = await kit.db.from('users').where('id', user.id).first()
    const remaining = await kit.db
      .from('social_identities')
      .where('user_id', user.id)
      .whereNotNull('confirmed_at')
    assert.lengthOf(remaining, 1)
    assert.equal(remaining[0].id, github.id)
    assert.equal(remaining[0].provider, 'github')
    assert.equal(remaining[0].provider_user_id, 'h-subject')
    assert.equal(after.email, user.email)
    assert.isNull(after.password)
    assert.notEqual(readIsoTimestamp(after.credentials_changed_at), null)
    assert.lengthOf(await kit.db.from('users'), 1)
    assert.lengthOf(await kit.db.from('social_sensitive_proofs').where('user_id', user.id), 0)

    // The losing transaction is denied by the revision change before it can reach the last-method
    // check. Verify that invariant directly with a fresh provider-authenticated proof.
    const freshCurrent = {
      userId: user.id,
      revision: readIsoTimestamp(after.credentials_changed_at),
    }
    const reauth = await account.socialAuthentication.begin({
      provider: 'github',
      intent: 'reauth',
      current: freshCurrent,
      purpose: 'social_unlink',
      clientChallenge,
    })
    const proof = await account.socialAuthentication.callback({
      state: reauth.state,
      callback: {},
      current: freshCurrent,
    })
    if (proof.status !== 'reauthenticated') throw new Error('Expected a fresh unlink proof')
    await assert.rejects(
      () =>
        account.socialAuthentication.unlink({
          current: freshCurrent,
          identityId: github.id,
          proof: proof.proof,
        }),
      LastLoginMethodError
    )
    assert.lengthOf(await kit.db.from('social_identities').where('user_id', user.id), 1)
  }).timeout(10_000)
})
