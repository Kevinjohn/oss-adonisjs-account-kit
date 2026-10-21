import { performance } from 'node:perf_hooks'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import {
  CapabilityDisabledError,
  DeliveryError,
  InvalidInputError,
  PostCommitError,
  ThrottledError,
} from '../src/errors.js'
import { clientChallengeFor } from '../src/magic_link.js'
import { hashToken } from '../src/tokens.js'
import type { AccountKitConfig, AccountUser, LifecycleEvent, UserId } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import {
  insertUser,
  makeConfig,
  makeService,
  makeUsersAdapter,
  tokenFrom,
} from './helpers/fakes.js'

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

test.group('magicLink.request', (group) => {
  const kit = useTestApp(group)
  const service = (overrides: Partial<AccountKitConfig> = {}) =>
    makeService(kit, {
      enabled,
      authentication: { guard: 'web', strategy: 'session' },
      minRequestMs: 0,
      ...overrides,
    })
  const request = (
    account: ReturnType<typeof service>['account'],
    email = 'person@example.test',
    clientKey = 'client'
  ) => account.magicLink.request({ email, clientKey, clientChallenge: challenge })

  test('stores a hash, the email and the client challenge, then notifies once', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const events: LifecycleEvent[] = []
    const { account, recorder } = service({
      onLifecycleEvent: async (event) => {
        events.push(event)
      },
    })
    assert.isUndefined(await request(account, '  PERSON@EXAMPLE.TEST '))
    assert.lengthOf(recorder.calls, 1)
    assert.equal(recorder.calls[0].method, 'magicLinkProvision')
    const [notified, url] = recorder.calls[0].args as [AccountUser, string]
    assert.equal(notified.id, user.id)
    assert.match(String(url), /^https:\/\/example\.test\/magic-link\//)
    const rows = await kit.db.from('login_link_tokens')
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].tokenable_id, user.id)
    assert.equal(rows[0].email, user.email)
    assert.equal(rows[0].hash, hashToken(tokenFrom(url)))
    assert.equal(rows[0].client_challenge, challenge)
    const lifetime =
      DateTime.fromJSDate(new Date(rows[0].expires_at)).toMillis() -
      DateTime.fromJSDate(new Date(rows[0].created_at)).toMillis()
    assert.equal(lifetime, 15 * 60 * 1000)
    assert.deepEqual(
      events.map((event) => event.type),
      ['magic_link.requested']
    )
  })

  test('unknown addresses are silent and both paths wait out the floor', async ({ assert }) => {
    await insertUser(kit)
    const { account, recorder } = service({ minRequestMs: 40 })
    let started = performance.now()
    await request(account, 'unknown@example.test', 'first')
    assert.isAtLeast(performance.now() - started, 40)
    started = performance.now()
    await request(account, 'person@example.test', 'second')
    assert.isAtLeast(performance.now() - started, 40)
    started = performance.now()
    await assert.rejects(
      () => account.magicLink.request({ email: 'bad', clientKey: 'x', clientChallenge: challenge }),
      InvalidInputError
    )
    assert.isAtLeast(performance.now() - started, 40)
    assert.lengthOf(recorder.calls, 1)
    assert.lengthOf(await kit.db.from('login_link_tokens'), 1)
  })

  test('a new request replaces the live link', async ({ assert }) => {
    await insertUser(kit)
    const { account, recorder } = service()
    await request(account, undefined, 'first')
    await request(account, undefined, 'second')
    const rows = await kit.db.from('login_link_tokens')
    assert.lengthOf(rows, 1)
    const [first, second] = recorder.calls.map((call) => tokenFrom(call.args[1]))
    assert.isFalse(await account.magicLink.inspect({ token: first }))
    assert.isTrue(await account.magicLink.inspect({ token: second }))
  })

  test('inactive and access-denied accounts get no link', async ({ assert }) => {
    const { account, recorder } = service()
    // Open registration lets anyone create an unconfirmed account for an address.
    await account.registration.register({ email: 'victim@example.test', password: 'password123' })
    recorder.calls.length = 0
    await request(account, 'victim@example.test')
    await insertUser(kit, { email: 'blocked@example.test' })
    const blocked = service({
      authentication: {
        guard: 'web',
        strategy: 'session',
        canAccess: async (user) => user.email !== 'blocked@example.test',
      },
    })
    await request(blocked.account, 'blocked@example.test')
    assert.lengthOf(await kit.db.from('login_link_tokens'), 0)
    assert.lengthOf(recorder.calls, 0)
    assert.lengthOf(blocked.recorder.calls, 0)
  })

  test('invalid input is rejected before any lookup', async ({ assert }) => {
    let lookups = 0
    const users = makeUsersAdapter(kit.db, kit.hash)
    const { account } = service({
      users: {
        ...users,
        async findByEmail(email, trx, options) {
          lookups++
          return users.findByEmail(email, trx, options)
        },
      },
    })
    for (const input of [
      { email: 'not-an-email', clientKey: 'x', clientChallenge: challenge },
      { email: 'person@example.test', clientKey: ' ', clientChallenge: challenge },
      { email: 'person@example.test', clientKey: 'x', clientChallenge: 'short' },
      { email: 'person@example.test', clientKey: 'x', clientChallenge: `${challenge}=` },
      { email: 'person@example.test', clientKey: 'x', clientChallenge: undefined as never },
    ])
      await assert.rejects(() => account.magicLink.request(input), InvalidInputError)
    assert.equal(lookups, 0)
  })

  test('the client and email budgets throttle before lookup', async ({ assert }) => {
    await insertUser(kit)
    const { account } = service()
    for (let index = 0; index < 5; index++)
      await request(account, `unknown${index}@example.test`, 'same-client')
    await assert.rejects(
      () => request(account, 'unknown5@example.test', 'same-client'),
      ThrottledError
    )
    for (let index = 0; index < 5; index++) await request(account, undefined, `client-${index}`)
    await assert.rejects(() => request(account, undefined, 'client-5'), ThrottledError)
  })

  test('delivery and lifecycle failures surface after the link commits', async ({ assert }) => {
    await insertUser(kit)
    const failing = service()
    failing.recorder.failOn('magicLinkProvision')
    await assert.rejects(() => request(failing.account), DeliveryError)
    assert.lengthOf(await kit.db.from('login_link_tokens'), 1)
    const observer = service({
      onLifecycleEvent: async () => {
        throw new Error('observer down')
      },
    })
    await assert.rejects(() => request(observer.account, undefined, 'other'), PostCommitError)
    assert.lengthOf(observer.recorder.calls, 1)
  })

  test('a disabled capability rejects every operation without touching rows', async ({
    assert,
  }) => {
    await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: { guard: 'web', strategy: 'session' },
      minRequestMs: 0,
    })
    await assert.rejects(() => request(account), CapabilityDisabledError)
    await assert.rejects(() => account.magicLink.inspect({ token: 'x' }), CapabilityDisabledError)
    await assert.rejects(
      () => account.magicLink.complete({ token: 'x', verifier }, sessionGuard()),
      CapabilityDisabledError
    )
    assert.lengthOf(await kit.db.from('login_link_tokens'), 0)
  })
})

test.group('magicLink config', (group) => {
  const kit = useTestApp(group)
  const users = () => makeUsersAdapter(kit.db, kit.hash)

  test('requires authentication, its hooks and a valid lifetime', ({ assert }) => {
    const base = () =>
      makeConfig({
        users: users(),
        enabled: ['magicLinkLogin'],
        authentication: { guard: 'web', strategy: 'session' },
      })
    assert.equal(defineConfig(base()).expiresIn.magicLink, '15m')
    assert.equal(
      defineConfig({ ...base(), expiresIn: { magicLink: '5m' } }).expiresIn.magicLink,
      '5m'
    )
    assert.throws(
      () => defineConfig({ ...base(), authentication: undefined }),
      /magicLinkLogin requires authentication/
    )
    assert.throws(
      () => defineConfig({ ...base(), urls: { ...base().urls, magicLink: undefined } }),
      /urls\.magicLink must be a function/
    )
    assert.throws(
      () =>
        defineConfig({ ...base(), notify: { ...base().notify, magicLinkProvision: undefined } }),
      /notify\.magicLinkProvision must be a function/
    )
    assert.throws(() => defineConfig({ ...base(), expiresIn: { magicLink: 'soon' } }))
    // Off by default.
    assert.notInclude(defineConfig({ ...base(), enabled: undefined }).enabled, 'magicLinkLogin')
  })
})
