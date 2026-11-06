import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { transaction } from '../src/db.js'
import { InvalidInputError, InvitationPendingError } from '../src/errors.js'
import { matchInvitation } from '../src/invitation_match.js'
import { registerManagedRoutes } from '../src/http/managed.js'
import type { AccountKitConfig, AuthorizationContext, LifecycleEvent } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { allowAll, insertUser, makeService, tokenFrom } from './helpers/fakes.js'
import { fakeManagedHttp, stubGuard } from './helpers/managed_http_fakes.js'

test.group('invitation scope', (group) => {
  const kit = useTestApp(group)
  const email = 'person@example.test'

  /** A service recording every authorization context, acceptance and lifecycle event. */
  function setup(overrides: Partial<AccountKitConfig> = {}) {
    const invites: Array<{ role: string; scope: string | null | undefined; inTrx: boolean }> = []
    const lists: AuthorizationContext[] = []
    const managed: Array<string | null> = []
    const accepted: Array<{ scope: string | null; role: string }> = []
    const events: LifecycleEvent[] = []
    const service = makeService(kit, {
      invitationThrottle: {
        sendActor: { requests: 100, duration: '1h' },
        sendRecipient: { requests: 100, duration: '1h' },
      },
      authorize: {
        invite: async (_actor, role, context) => {
          invites.push({ role, scope: context?.scope, inTrx: context?.trx !== undefined })
          return true
        },
        manageInvitation: async (_actor, invitation) => {
          managed.push(invitation.scope)
          return true
        },
        listInvitations: async (_actor, context) => {
          lists.push(context ?? {})
          return true
        },
      },
      onInvitationAccepted: async (_user, invitation) => {
        accepted.push({ scope: invitation.scope, role: invitation.role })
      },
      onLifecycleEvent: async (event) => {
        events.push(event)
      },
      ...overrides,
    })
    return { ...service, invites, lists, managed, accepted, events }
  }

  test('one address can hold one pending invitation per scope', async ({ assert }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account, invites } = setup()
    const first = await account.invitations.send({
      actorId: actor.id,
      email,
      role: 'member',
      scope: 'team-a',
    })
    const second = await account.invitations.send({
      actorId: actor.id,
      email,
      role: 'admin',
      scope: 'team-b',
    })
    const unscoped = await account.invitations.send({ actorId: actor.id, email, role: 'guest' })
    assert.equal(first.scope, 'team-a')
    assert.equal(second.scope, 'team-b')
    assert.isNull(unscoped.scope)
    assert.lengthOf(await kit.db.from('account_invitations').where('email', email), 3)
    // Both calls of `invite` carry the scope: the context-free check and the in-transaction recheck.
    assert.deepEqual(invites.slice(0, 2), [
      { role: 'member', scope: 'team-a', inTrx: false },
      { role: 'member', scope: 'team-a', inTrx: true },
    ])
    assert.deepEqual(invites.slice(4), [
      { role: 'guest', scope: null, inTrx: false },
      { role: 'guest', scope: null, inTrx: true },
    ])

    await assert.rejects(
      () => account.invitations.send({ actorId: actor.id, email, role: 'member', scope: 'team-a' }),
      InvitationPendingError
    )
    await assert.rejects(
      () => account.invitations.send({ actorId: actor.id, email, role: 'member' }),
      InvitationPendingError
    )
    assert.lengthOf(await kit.db.from('account_invitations').where('email', email), 3)
  })

  test('rejects a malformed scope on send and list', async ({ assert }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account } = setup()
    for (const scope of ['', 'x'.repeat(256), 7 as unknown as string]) {
      await assert.rejects(
        () => account.invitations.send({ actorId: actor.id, email, role: 'member', scope }),
        InvalidInputError
      )
      await assert.rejects(
        () => account.invitations.list({ actorId: actor.id, scope }),
        InvalidInputError
      )
    }
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
  })

  test('lists one scope, unscoped invitations, or every scope', async ({ assert }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account, lists } = setup()
    await account.invitations.send({ actorId: actor.id, email, role: 'member', scope: 'team-a' })
    await account.invitations.send({
      actorId: actor.id,
      email: 'other@example.test',
      role: 'member',
      scope: 'team-b',
    })
    await account.invitations.send({ actorId: actor.id, email, role: 'guest' })

    const teamA = await account.invitations.list({ actorId: actor.id, scope: 'team-a' })
    assert.deepEqual(
      teamA.items.map((item) => [item.email, item.scope]),
      [[email, 'team-a']]
    )
    const unscoped = await account.invitations.list({ actorId: actor.id, scope: null })
    assert.deepEqual(
      unscoped.items.map((item) => [item.email, item.scope]),
      [[email, null]]
    )
    const all = await account.invitations.list({ actorId: actor.id })
    assert.lengthOf(all.items, 3)
    assert.deepEqual(lists, [{ scope: 'team-a' }, { scope: null }, {}])
  })

  test('accepting one invitation applies every pending invitation for the address in scope order', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account, recorder, accepted, events } = setup()
    await account.invitations.send({ actorId: actor.id, email, role: 'member', scope: 'team-b' })
    const token = tokenFrom(recorder.calls.at(-1)!.args[1])
    await account.invitations.send({ actorId: actor.id, email, role: 'guest' })
    await account.invitations.send({ actorId: actor.id, email, role: 'admin', scope: 'team-a' })
    await account.invitations.send({
      actorId: actor.id,
      email: 'other@example.test',
      role: 'admin',
      scope: 'team-a',
    })
    const pending = await kit.db.from('account_invitations').where('email', email).orderBy('scope')

    const user = await account.invitations.accept({ token, password: 'LongerPassword12345' })
    assert.equal(user.email, email)
    assert.deepEqual(accepted, [
      { scope: null, role: 'guest' },
      { scope: 'team-a', role: 'admin' },
      { scope: 'team-b', role: 'member' },
    ])
    assert.deepEqual(
      events
        .filter((event) => event.type === 'invitation.accepted')
        .map((event) => event.invitationId),
      pending.map((row) => row.id)
    )
    assert.lengthOf(await kit.db.from('account_invitations').where('email', email), 0)
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
  })

  test('a throwing callback for a later scope rolls back the whole acceptance', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account, recorder } = setup({
      onInvitationAccepted: async (_user, invitation) => {
        if (invitation.scope === 'team-b') throw new Error('team-b is closed')
      },
    })
    await account.invitations.send({ actorId: actor.id, email, role: 'member', scope: 'team-a' })
    const token = tokenFrom(recorder.calls.at(-1)!.args[1])
    await account.invitations.send({ actorId: actor.id, email, role: 'member', scope: 'team-b' })
    await assert.rejects(
      () => account.invitations.accept({ token, password: 'LongerPassword12345' }),
      /team-b is closed/
    )
    assert.isNull(await kit.db.from('users').where('email', email).first())
    assert.lengthOf(await kit.db.from('account_invitations').where('email', email), 2)
  })

  test('signing in with the invited address applies every pending invitation in scope order', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account, config, accepted } = setup()
    await account.invitations.send({ actorId: actor.id, email, role: 'member', scope: 'team-b' })
    await account.invitations.send({ actorId: actor.id, email, role: 'admin', scope: 'team-a' })
    const pending = await kit.db.from('account_invitations').where('email', email).orderBy('scope')
    const person = await insertUser(kit, { email })

    const ids = await transaction(kit.db, (trx) =>
      matchInvitation(config, trx, person, DateTime.utc())
    )
    assert.deepEqual(
      ids,
      pending.map((row) => row.id)
    )
    assert.deepEqual(accepted, [
      { scope: 'team-a', role: 'admin' },
      { scope: 'team-b', role: 'member' },
    ])
    assert.lengthOf(await kit.db.from('account_invitations'), 0)
  })

  test('resend rechecks invite with the scope and management sees the scope', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account, invites, managed } = setup()
    const invitation = await account.invitations.send({
      actorId: actor.id,
      email,
      role: 'member',
      scope: 'team-a',
    })
    invites.length = 0
    await account.invitations.resend({ actorId: actor.id, invitationId: invitation.id })
    assert.deepEqual(invites, [
      { role: 'member', scope: 'team-a', inTrx: true },
      { role: 'member', scope: 'team-a', inTrx: true },
    ])
    await account.invitations.revoke({ actorId: actor.id, invitationId: invitation.id })
    assert.deepEqual(managed, ['team-a', 'team-a', 'team-a'])
  })

  test('the managed send and list routes pass the scope through', async ({ assert }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account, lists } = setup({ authentication: { strategy: 'session', guard: 'web' } })
    const { router, routes, context } = fakeManagedHttp()
    registerManagedRoutes(router, {
      prefix: '/api/v1',
      kit: async () => account,
      guard: stubGuard({ current: async () => ({ userId: actor.id, revision: null }) }),
      enabled: ['invitations'],
      verificationRequired: false,
    })
    const send = context()
    Object.assign(send.request, {
      csrfToken: 'proof',
      validateUsing: async () => ({ email, role: 'member', scope: 'team-a' }),
    })
    const sent = (await routes.get('POST /api/v1/account/invitations')!(send)) as { status: number }
    assert.equal(sent.status, 201)
    const list = context()
    list.request.validateUsing = (async () => ({ scope: 'team-a' })) as never
    const page = (await routes.get('GET /api/v1/account/invitations')!(list)) as {
      status: number
      body: { items: Array<{ scope: string | null }> }
    }
    assert.equal(page.status, 200)
    assert.deepEqual(
      page.body.items.map((item) => item.scope),
      ['team-a']
    )
    assert.deepEqual(lists, [{ scope: 'team-a' }])
  })

  test('default policy helpers still allow unscoped use', async ({ assert }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account } = makeService(kit, { authorize: allowAll })
    const invitation = await account.invitations.send({ actorId: actor.id, email, role: 'member' })
    assert.isNull(invitation.scope)
    const page = await account.invitations.list({ actorId: actor.id })
    assert.deepEqual(
      page.items.map((item) => item.scope),
      [null]
    )
  })
})
