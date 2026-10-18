import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { defineConfig } from '../src/config.js'
import { InvalidCredentialsError, InvalidSessionError } from '../src/errors.js'
import { pruneExpired } from '../src/maintenance.js'
import { hashToken } from '../src/tokens.js'
import type { AccountKitConfig, CurrentAccountInput, UserId } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import {
  insertUser,
  makeConfig,
  makeService,
  makeUsersAdapter,
  tokenFrom,
} from './helpers/fakes.js'
import { clientChallenge, provider, verifier } from './helpers/social_identity.js'

const minutesAgo = (minutes: number) => DateTime.utc().minus({ minutes }).toISO()

/** A session guard adapter that remembers what the real guard would store in the session. */
function sessionGuard() {
  const established: unknown[][] = []
  let stored: { revision: string | null; handle?: string } | undefined
  return {
    established,
    input(userId: UserId): CurrentAccountInput {
      return {
        userId,
        revision: stored!.revision,
        ...(stored?.handle ? { sessionHandle: stored.handle } : {}),
      }
    },
    guard: {
      strategy: 'session' as const,
      name: 'web',
      async establish(...args: [UserId, string | null, string?]) {
        established.push(args)
        stored = { revision: args[1], handle: args[2] }
        return 'cookie'
      },
      async terminate() {},
    },
  }
}

test.group('session registry', (group) => {
  const kit = useTestApp(group)
  const service = (overrides: Partial<AccountKitConfig> = {}) =>
    makeService(kit, {
      enabled: [
        'passwordReset',
        'emailVerification',
        'emailPasswordManagement',
        'sessionManagement',
      ],
      authentication: { strategy: 'session', guard: 'web' },
      minRequestMs: 0,
      ...overrides,
    })
  const login = async (
    account: ReturnType<typeof service>['account'],
    session = sessionGuard(),
    sessionLabel?: string
  ) => {
    await account.authentication.login(
      { email: 'person@example.test', password: 'password123', clientKey: 'client', sessionLabel },
      session.guard
    )
    return session
  }

  test('login hands the guard a handle and stores only its hash with the label', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = service()
    const session = await login(account, undefined, 'x'.repeat(300))
    const [[id, revision, handle]] = session.established
    assert.equal(id, user.id)
    assert.isNull(revision)
    assert.match(handle as string, /^[\w-]{43}$/)
    const rows = await kit.db.from('account_sessions')
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].handle_hash, hashToken(handle as string))
    assert.equal(rows[0].label, 'x'.repeat(255))
    assert.equal(String(rows[0].user_id), String(user.id))
    const lifetime =
      new Date(rows[0].expires_at).getTime() - new Date(rows[0].last_seen_at).getTime()
    assert.equal(lifetime, 30 * 24 * 60 * 60 * 1000)
    const signedIn = await account.authentication.current(session.input(user.id))
    assert.equal(signedIn.id, user.id)
  })

  test('without the capability the guard gets no handle and current needs none', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { strategy: 'session', guard: 'web' },
      minRequestMs: 0,
    })
    const session = await login(account)
    assert.deepEqual(session.established, [[user.id, null]])
    assert.lengthOf(await kit.db.from('account_sessions'), 0)
    const plain = await account.authentication.current({ userId: user.id, revision: null })
    assert.equal(plain.id, user.id)
  })

  test('missing, foreign and expired handles are rejected without deleting rows', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const other = await insertUser(kit, { email: 'other@example.test' })
    const { account } = service()
    const mine = await login(account)
    const theirs = sessionGuard()
    await account.authentication.login(
      { email: other.email, password: 'password123', clientKey: 'client' },
      theirs.guard
    )
    // A session from before the capability was enabled has no handle.
    await assert.rejects(
      () => account.authentication.current({ userId: user.id, revision: null }),
      InvalidSessionError
    )
    await assert.rejects(
      () =>
        account.authentication.current({
          ...mine.input(user.id),
          sessionHandle: theirs.input(other.id).sessionHandle,
        }),
      InvalidSessionError
    )
    await kit.db
      .from('account_sessions')
      .where('user_id', user.id)
      .update({ expires_at: minutesAgo(1) })
    await assert.rejects(
      () => account.authentication.current(mine.input(user.id)),
      InvalidSessionError
    )
    assert.lengthOf(await kit.db.from('account_sessions'), 2)
    const stillSignedIn = await account.authentication.current(theirs.input(other.id))
    assert.equal(stillSignedIn.id, other.id)
  })

  test('accepted requests extend a sign-in at most once per interval; rejected ones never', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    let allowed = true
    const { account } = service({
      authentication: { strategy: 'session', guard: 'web', canAccess: async () => allowed },
    })
    const session = await login(account)
    const row = () => kit.db.from('account_sessions').first()
    const issued = await row()
    await account.authentication.current(session.input(user.id))
    assert.deepEqual(await row(), issued)

    const stale = {
      last_seen_at: minutesAgo(6),
      expires_at: DateTime.utc().plus({ days: 1 }).toISO(),
    }
    await kit.db.from('account_sessions').update(stale)
    allowed = false
    await assert.rejects(
      () => account.authentication.current(session.input(user.id)),
      InvalidSessionError
    )
    const untouched = await row()
    assert.equal(new Date(untouched.last_seen_at).getTime(), Date.parse(stale.last_seen_at))

    allowed = true
    await account.authentication.current(session.input(user.id))
    const touched = await row()
    assert.isAbove(new Date(touched.last_seen_at).getTime(), Date.now() - 60_000)
    assert.isAbove(new Date(touched.expires_at).getTime(), Date.now() + 29 * 24 * 60 * 60 * 1000)
  })

  test('a failed post-issuance check stores no row and terminates the credential', async ({
    assert,
  }) => {
    await insertUser(kit)
    let checks = 0
    const { account } = service({
      authentication: {
        strategy: 'session',
        guard: 'web',
        canAccess: async () => ++checks !== 2,
      },
    })
    const terminated: unknown[] = []
    const session = sessionGuard()
    await assert.rejects(
      () =>
        account.authentication.login(
          { email: 'person@example.test', password: 'password123', clientKey: 'client' },
          {
            ...session.guard,
            terminate: async (credential?: string) => void terminated.push(credential),
          }
        ),
      InvalidCredentialsError
    )
    assert.deepEqual(terminated, ['cookie'])
    assert.lengthOf(await kit.db.from('account_sessions'), 0)
  })

  test('logout with the current input removes only that sign-in', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account } = service()
    const first = await login(account)
    const second = await login(account)
    await account.authentication.logout(first.guard, undefined)
    assert.lengthOf(await kit.db.from('account_sessions'), 2)
    await account.authentication.logout(first.guard, undefined, first.input(user.id))
    const rows = await kit.db.from('account_sessions')
    assert.deepEqual(
      rows.map((row) => row.handle_hash),
      [hashToken(second.input(user.id).sessionHandle!)]
    )
  })

  test('every credential change signs out every session', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account, recorder } = service()
    const live = () => kit.db.from('account_sessions').where('user_id', user.id)

    await login(account)
    await account.emailPasswordManagement.changePassword({
      actorId: user.id,
      currentPassword: 'password123',
      newPassword: 'newPassword123',
    })
    assert.lengthOf(await live(), 0, 'password change')

    await account.authentication.login(
      { email: user.email, password: 'newPassword123', clientKey: 'client' },
      sessionGuard().guard
    )
    await account.passwordReset.request({ email: user.email, clientKey: 'reset' })
    const reset = tokenFrom(
      recorder.calls.findLast((call) => call.method === 'passwordResetProvision')!.args[1]
    )
    await account.passwordReset.reset({ token: reset, password: 'password123' })
    assert.lengthOf(await live(), 0, 'password reset')

    await login(account)
    await account.authentication.changeRestriction({ userId: user.id, change: async () => {} })
    assert.lengthOf(await live(), 0, 'restriction change')

    // The registry is cleared even while the capability is off.
    await login(account)
    const off = makeService(kit, { authentication: { strategy: 'session', guard: 'web' } })
    await off.account.authentication.changeRestriction({ userId: user.id, change: async () => {} })
    assert.lengthOf(await live(), 0, 'capability off')
  })

  test('social handoff redemption issues a handle too', async ({ assert }) => {
    const { account } = makeService(kit, {
      enabled: ['socialAuthentication', 'emailVerification', 'sessionManagement'],
      registration: { availability: 'open' },
      socialAuthentication: {
        providers: { google: provider('handoff-subject', 'handoff@example.test', true) },
      },
      authentication: { strategy: 'session', guard: 'web' },
    })
    const start = await account.socialAuthentication.begin({
      provider: 'google',
      intent: 'login',
      clientChallenge,
    })
    const result = await account.socialAuthentication.callback({ state: start.state, callback: {} })
    if (!('handoffCode' in result) || !result.handoffCode) throw new Error('Expected handoff')
    const session = sessionGuard()
    const exchanged = await account.socialAuthentication.redeemHandoff({
      code: result.handoffCode,
      verifier,
      guard: session.guard,
    })
    const handle = session.input(exchanged.account.id).sessionHandle!
    assert.match(handle, /^[\w-]{43}$/)
    const rows = await kit.db.from('account_sessions')
    assert.deepEqual(
      rows.map((row) => row.handle_hash),
      [hashToken(handle)]
    )
    await account.authentication.current(session.input(exchanged.account.id))
  })

  test('prune removes expired sign-ins and keeps a recently extended one', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account } = service()
    await login(account)
    await login(account)
    const [expired, live] = await kit.db.from('account_sessions').orderBy('id')
    await kit.db
      .from('account_sessions')
      .where('id', expired.id)
      .update({ expires_at: minutesAgo(1) })
    const dryRun = await pruneExpired(kit.db, { dryRun: true })
    assert.equal(dryRun.sessions, 1)
    const pruned = await pruneExpired(kit.db)
    assert.equal(pruned.sessions, 1)
    const left = await kit.db.from('account_sessions').where('user_id', user.id)
    assert.deepEqual(
      left.map((row) => row.id),
      [live.id]
    )
  })
})

test.group('session management config', (group) => {
  const kit = useTestApp(group)
  const base = (overrides: Partial<AccountKitConfig> = {}) =>
    makeConfig({
      users: makeUsersAdapter(kit.db, kit.hash),
      enabled: ['sessionManagement'],
      authentication: { strategy: 'session', guard: 'web' },
      ...overrides,
    })

  test('idle expiry defaults to 30 days and must exceed the five-minute touch interval', ({
    assert,
  }) => {
    assert.deepEqual(defineConfig(base()).sessionManagement, { idleExpiry: '30d' })
    for (const idleExpiry of ['6m', 301, '1h'])
      assert.deepEqual(
        defineConfig(base({ sessionManagement: { idleExpiry } })).sessionManagement,
        {
          idleExpiry,
        }
      )
    for (const idleExpiry of ['5m', 300, '1m'])
      assert.throws(
        () => defineConfig(base({ sessionManagement: { idleExpiry } })),
        /idleExpiry must be longer than five minutes/
      )
    assert.throws(() => defineConfig(base({ sessionManagement: { idleExpiry: 'soon' } })))
    assert.throws(
      () => defineConfig(base({ sessionManagement: [] as never })),
      /sessionManagement must be an object/
    )
    assert.throws(
      () => defineConfig(base({ authentication: undefined })),
      /sessionManagement requires authentication/
    )
    assert.notInclude(defineConfig(base({ enabled: undefined })).enabled, 'sessionManagement')
  })
})
