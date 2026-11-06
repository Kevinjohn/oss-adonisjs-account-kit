import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { InvalidCredentialsError, InvalidTokenError } from '../src/errors.js'
import { clientChallengeFor } from '../src/magic_link.js'
import type { AccountKitConfig, UserId } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService, makeUsersAdapter, tokenFrom } from './helpers/fakes.js'
import { dbTime } from './helpers/db_time.js'

const verifier = 'v'.repeat(43)
const challenge = clientChallengeFor(verifier)
const enabled: AccountKitConfig['enabled'] = [
  'passwordReset',
  'emailVerification',
  'emailPasswordManagement',
  'registration',
  'magicLinkLogin',
]

function sessionGuard(events: unknown[] = []) {
  return {
    strategy: 'session' as const,
    name: 'web',
    establish: async (id: UserId, revision: string | null) => {
      events.push(['establish', id, revision])
      return `session:${id}`
    },
    terminate: async (credential?: string) => {
      events.push(['terminate', credential])
    },
  }
}

test.group('magicLink.complete', (group) => {
  const kit = useTestApp(group)
  const service = (overrides: Partial<AccountKitConfig> = {}) =>
    makeService(kit, {
      enabled,
      authentication: { guard: 'web', strategy: 'session' },
      minRequestMs: 0,
      ...overrides,
    })

  async function issue(overrides: Partial<AccountKitConfig> = {}) {
    const user = await insertUser(kit)
    const { account, recorder } = service(overrides)
    await account.magicLink.request({
      email: user.email,
      clientKey: 'client',
      clientChallenge: challenge,
    })
    return { user, account, token: tokenFrom(recorder.calls.at(-1)!.args[1]) }
  }

  test('an address changed while the sign-in is established refuses it and ends it', async ({
    assert,
  }) => {
    const { user, account, token } = await issue()
    const events: unknown[] = []
    const guard = sessionGuard(events)
    await assert.rejects(
      () =>
        account.magicLink.complete(
          { token, verifier },
          {
            ...guard,
            establish: async (id: UserId, revision: string | null) => {
              await kit.db
                .from('users')
                .where('id', user.id)
                .update({ email: 'moved@example.test' })
              return guard.establish(id, revision)
            },
          }
        ),
      InvalidCredentialsError
    )
    assert.deepEqual(events.at(-1), ['terminate', `session:${user.id}`])
  })

  test('a request for an address that moves before its lock issues no link', async ({ assert }) => {
    const user = await insertUser(kit)
    const users = makeUsersAdapter(kit.db, kit.hash)
    const { account, recorder } = service({
      users: {
        ...users,
        async findByEmail(...args) {
          const found = await users.findByEmail(...args)
          await kit.db.from('users').where('id', user.id).update({ email: 'moved@example.test' })
          return found
        },
      },
    })
    await account.magicLink.request({
      email: user.email,
      clientKey: 'client',
      clientChallenge: challenge,
    })
    assert.lengthOf(await kit.db.from('login_link_tokens'), 0)
    assert.lengthOf(recorder.calls, 0)
  })

  test('inspection does not consume and completion signs in once', async ({ assert }) => {
    const { user, account, token } = await issue()
    assert.isTrue(await account.magicLink.inspect({ token }))
    assert.isTrue(await account.magicLink.inspect({ token }))
    const events: unknown[] = []
    const result = await account.magicLink.complete({ token, verifier }, sessionGuard(events))
    assert.equal(result.account.id, user.id)
    assert.equal(result.credential, `session:${user.id}`)
    assert.deepEqual(events, [['establish', user.id, null]])
    assert.lengthOf(await kit.db.from('login_link_tokens'), 0)
    assert.isFalse(await account.magicLink.inspect({ token }))
    await assert.rejects(
      () => account.magicLink.complete({ token, verifier }, sessionGuard()),
      InvalidTokenError
    )
  })

  test('the session revision is the current credential stamp', async ({ assert }) => {
    const { user, account, token } = await issue()
    await kit.db
      .from('users')
      .where('id', user.id)
      .update({ credentials_changed_at: dbTime(kit, '2026-01-02T03:04:05.678Z') })
    const events: unknown[] = []
    await account.magicLink.complete({ token, verifier }, sessionGuard(events))
    assert.deepEqual(events, [['establish', user.id, '2026-01-02T03:04:05.678Z']])
  })

  async function reissue(email: string): Promise<string> {
    const { account, recorder } = service()
    await account.magicLink.request({ email, clientKey: 'reissue', clientChallenge: challenge })
    return tokenFrom(recorder.calls.at(-1)!.args[1])
  }

  test('a wrong verifier fails and burns the link; a malformed one consumes nothing', async ({
    assert,
  }) => {
    const { account, token } = await issue()
    for (const bad of ['', 'short', `${verifier}!`, undefined as never])
      await assert.rejects(
        () => account.magicLink.complete({ token, verifier: bad }, sessionGuard()),
        InvalidTokenError
      )
    assert.isTrue(await account.magicLink.inspect({ token }))
    await assert.rejects(
      () => account.magicLink.complete({ token, verifier: 'w'.repeat(43) }, sessionGuard()),
      InvalidTokenError
    )
    assert.isFalse(await account.magicLink.inspect({ token }))
    await assert.rejects(
      () => account.magicLink.complete({ token, verifier }, sessionGuard()),
      InvalidTokenError
    )
  })

  test('expired links and links for a changed email are rejected', async ({ assert }) => {
    const { user, account, token } = await issue()
    await kit.db
      .from('login_link_tokens')
      .update({ expires_at: dbTime(kit, DateTime.utc().minus({ minutes: 1 })) })
    assert.isFalse(await account.magicLink.inspect({ token }))
    await assert.rejects(
      () => account.magicLink.complete({ token, verifier }, sessionGuard()),
      InvalidTokenError
    )
    const next = await reissue(user.email)
    await kit.db.from('users').where('id', user.id).update({ email: 'moved@example.test' })
    assert.isFalse(await account.magicLink.inspect({ token: next }))
    await assert.rejects(
      () => account.magicLink.complete({ token: next, verifier }, sessionGuard()),
      InvalidTokenError
    )
  })

  test('inactive and access-denied accounts cannot complete', async ({ assert }) => {
    let allowed = true
    let accessChecks = 0
    const { user, account, token } = await issue({
      authentication: {
        guard: 'web',
        strategy: 'session',
        canAccess: async () => {
          accessChecks++
          return allowed
        },
      },
    })
    const issuedRow = await kit.db.from('login_link_tokens').where('tokenable_id', user.id).first()
    assert.equal(accessChecks, 1)
    allowed = false
    assert.isTrue(await account.magicLink.inspect({ token }))
    assert.equal(accessChecks, 1, 'inspection must not evaluate access policy')
    assert.deepEqual(
      await kit.db.from('login_link_tokens').where('tokenable_id', user.id).first(),
      issuedRow,
      'inspection must leave the issued proof row unchanged'
    )
    await assert.rejects(
      () => account.magicLink.complete({ token, verifier }, sessionGuard()),
      InvalidTokenError
    )
    assert.equal(accessChecks, 2)
    assert.lengthOf(await kit.db.from('login_link_tokens'), 0)
    assert.isFalse(await account.magicLink.inspect({ token }))
    allowed = true
    const next = await reissue(user.email)
    await kit.db.from('users').where('id', user.id).update({ unverified_email: user.email })
    assert.isFalse(await account.magicLink.inspect({ token: next }))
    await assert.rejects(
      () => account.magicLink.complete({ token: next, verifier }, sessionGuard()),
      InvalidTokenError
    )
  })

  test('a guard mismatch consumes nothing', async ({ assert }) => {
    const { account, token } = await issue()
    await assert.rejects(
      () => account.magicLink.complete({ token, verifier }, { ...sessionGuard(), name: 'api' }),
      /expected web session guard/
    )
    assert.isTrue(await account.magicLink.inspect({ token }))
  })

  test('establishment and re-check failures terminate the credential', async ({ assert }) => {
    let checks = 0
    const { account, token, user } = await issue({
      authentication: {
        guard: 'web',
        strategy: 'session',
        // Request, completion, then the post-issuance re-check under the lock.
        canAccess: async () => ++checks !== 3,
      },
    })
    const events: unknown[] = []
    await assert.rejects(
      () => account.magicLink.complete({ token, verifier }, sessionGuard(events)),
      InvalidCredentialsError
    )
    assert.deepEqual(events, [
      ['establish', user.id, null],
      ['terminate', `session:${user.id}`],
    ])
    assert.isFalse(await account.magicLink.inspect({ token }))

    const next = await reissue(user.email)
    const terminated: unknown[] = []
    await assert.rejects(
      () =>
        account.magicLink.complete(
          { token: next, verifier },
          {
            ...sessionGuard(),
            establish: async () => {
              throw new Error('session store down')
            },
            terminate: async (credential?: string) => {
              terminated.push(credential)
            },
          }
        ),
      /session store down/
    )
    assert.deepEqual(terminated, [undefined])
  })

  test('two concurrent completions sign in once', async ({ assert }) => {
    const { account, token } = await issue()
    const results = await Promise.allSettled([
      account.magicLink.complete({ token, verifier }, sessionGuard()),
      account.magicLink.complete({ token, verifier }, sessionGuard()),
    ])
    assert.lengthOf(
      results.filter((result) => result.status === 'fulfilled'),
      1
    )
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    assert.instanceOf(rejected.reason, InvalidTokenError)
  })

  test('access-token guards receive the configured abilities and lifetime', async ({ assert }) => {
    const user = await insertUser(kit)
    const { account, recorder } = service({
      authentication: {
        guard: 'api',
        strategy: 'access_tokens',
        tokenAbilities: ['read'],
        tokenExpiresIn: '1h',
      },
    })
    await account.magicLink.request({
      email: user.email,
      clientKey: 'client',
      clientChallenge: challenge,
    })
    const established: unknown[] = []
    const result = await account.magicLink.complete(
      { token: tokenFrom(recorder.calls[0].args[1]), verifier },
      {
        strategy: 'access_tokens',
        name: 'api',
        establish: async (id: UserId, abilities: string[], expiresIn: string | number | null) => {
          established.push([id, abilities, expiresIn])
          return 'token-credential'
        },
        terminate: async () => {},
      }
    )
    assert.equal(result.credential, 'token-credential')
    assert.deepEqual(established, [[user.id, ['read'], '1h']])
  })
})

test.group('magic links and credential changes', (group) => {
  const kit = useTestApp(group)
  const service = (overrides: Partial<AccountKitConfig> = {}) =>
    makeService(kit, {
      enabled,
      authentication: { guard: 'web', strategy: 'session' },
      minRequestMs: 0,
      ...overrides,
    })

  async function issued(email = 'person@example.test') {
    const { account, recorder } = service()
    await account.magicLink.request({ email, clientKey: email, clientChallenge: challenge })
    return tokenFrom(recorder.calls.at(-1)!.args[1])
  }

  test('every credential change deletes the user’s links', async ({ assert }) => {
    const user = await insertUser(kit, { password: 'oldPassword123' })
    const { account, recorder } = service()
    const live = () => kit.db.from('login_link_tokens').where('tokenable_id', user.id)

    await issued()
    await account.emailPasswordManagement.changePassword({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newPassword: 'newPassword123',
    })
    assert.lengthOf(await live(), 0, 'password change')

    await issued()
    await account.passwordReset.request({ email: user.email, clientKey: 'reset' })
    const reset = tokenFrom(
      recorder.calls.findLast((call) => call.method === 'passwordResetProvision')!.args[1]
    )
    await account.passwordReset.reset({ token: reset, password: 'resetPassword123' })
    assert.lengthOf(await live(), 0, 'password reset')

    await issued()
    await account.authentication.changeRestriction({ userId: user.id, change: async () => {} })
    assert.lengthOf(await live(), 0, 'restriction change')

    await issued()
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'resetPassword123',
      newEmail: 'next@example.test',
    })
    const change = tokenFrom(
      recorder.calls.findLast((call) => call.method === 'emailChangeProvision')!.args[2]
    )
    await account.emailPasswordManagement.completeEmailChange({ token: change })
    assert.lengthOf(await live(), 0, 'email change')
  })

  test('disabling the capability, changing credentials and re-enabling leaves no link', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const token = await issued()
    const disabled = makeService(kit, {
      authentication: { guard: 'web', strategy: 'session' },
      minRequestMs: 0,
    }).account
    await disabled.authentication.changeRestriction({ userId: user.id, change: async () => {} })
    const { account } = service()
    assert.isFalse(await account.magicLink.inspect({ token }))
    await assert.rejects(
      () => account.magicLink.complete({ token, verifier }, sessionGuard()),
      InvalidTokenError
    )
  })
})

test.group('magic-link policy contract routing', (group) => {
  const kit = useTestApp(group)
  for (const boundary of ['request', 'complete', 'issuance'] as const) {
    for (const malformed of ['private truthy result', 0]) {
      test(`${boundary} rejects ${typeof malformed} policy results`, async ({ assert }) => {
        const user = await insertUser(kit)
        let value: unknown = boundary === 'request' ? malformed : true
        const { account, recorder } = makeService(kit, {
          enabled,
          minRequestMs: 0,
          authentication: {
            guard: 'web',
            strategy: 'session',
            canAccess: async () => value as never,
          },
        })
        let established = false
        let active = false
        let terminated = false
        const guard = {
          strategy: 'session' as const,
          name: 'web',
          establish: async () => {
            established = true
            active = true
            value = malformed
            return 'provisional-magic-session'
          },
          terminate: async (credential?: string) => {
            assert.equal(credential, 'provisional-magic-session')
            terminated = true
            active = false
          },
        }
        const request = () =>
          account.magicLink.request({
            email: user.email,
            clientKey: 'contract',
            clientChallenge: challenge,
          })
        let error: unknown
        if (boundary === 'request') error = await request().catch((caught: unknown) => caught)
        else {
          await request()
          const token = tokenFrom(recorder.calls.at(-1)!.args[1])
          if (boundary === 'complete') value = malformed
          error = await account.magicLink
            .complete({ token, verifier }, guard)
            .catch((caught: unknown) => caught)
        }
        assert.instanceOf(error, Error)
        assert.notInstanceOf(error, InvalidTokenError)
        assert.notInstanceOf(error, InvalidCredentialsError)
        assert.equal((error as Error).message, 'account_kit: canAccess must resolve to a boolean')
        assert.equal(established, boundary === 'issuance')
        assert.equal(terminated, boundary === 'issuance')
        assert.isFalse(active)
        if (boundary === 'request') {
          assert.lengthOf(recorder.calls, 0)
          assert.lengthOf(await kit.db.from('login_link_tokens'), 0)
        }
      })
    }
  }
})
