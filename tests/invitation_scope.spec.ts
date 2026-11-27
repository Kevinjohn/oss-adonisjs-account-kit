import { RequestValidator } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { transaction } from '../src/db.ts'
import { E_ACCOUNT_KIT_INVALID_INPUT, E_ACCOUNT_KIT_INVITATION_PENDING } from '../src/errors.ts'
import { matchInvitation } from '../src/invitation_match.ts'
import { ManagedRoutes } from '../src/http/route_registration.ts'
import type { AccountKitConfig, AuthorizationContext, LifecycleNotification } from '../src/types.ts'
import { useTestApp } from './helpers/app.ts'
import { allowAll, insertUser, makeService, tokenFrom } from './helpers/fakes.ts'
import { fakeManagedHttp, requestWithHeaders, stubGuard } from './helpers/managed_http_fakes.ts'

test.group('invitation scope', (group) => {
  const kit = useTestApp(group)
  const email = 'person@example.test'

  /** A service recording every authorization context, acceptance and lifecycle event. */
  function setup(overrides: Partial<AccountKitConfig> = {}) {
    const invites: Array<{ role: string; scope: string | null | undefined; inTrx: boolean }> = []
    const lists: AuthorizationContext[] = []
    const managed: Array<string | null> = []
    const accepted: Array<{ scope: string | null; role: string }> = []
    const events: LifecycleNotification[] = []
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
      onLifecycleNotification: async (event) => {
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
      E_ACCOUNT_KIT_INVITATION_PENDING
    )
    await assert.rejects(
      () => account.invitations.send({ actorId: actor.id, email, role: 'member' }),
      E_ACCOUNT_KIT_INVITATION_PENDING
    )
    assert.lengthOf(await kit.db.from('account_invitations').where('email', email), 3)
  })

  test('rejects a malformed scope on send and list', async ({ assert }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account } = setup()
    for (const scope of ['', 'x'.repeat(256), 7 as unknown as string]) {
      await assert.rejects(
        () => account.invitations.send({ actorId: actor.id, email, role: 'member', scope }),
        E_ACCOUNT_KIT_INVALID_INPUT
      )
      await assert.rejects(
        () => account.invitations.list({ actorId: actor.id, scope }),
        E_ACCOUNT_KIT_INVALID_INPUT
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

  test('direct invitations preserve role and scope text and enforce the input bounds', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account, invites, lists } = setup()
    const maxRole = 'r'.repeat(64)
    const maxScope = 's'.repeat(255)
    const inputs = [
      { role: 'r', scope: 's' },
      { role: maxRole, scope: maxScope },
      { role: ' r ' },
      { role: ' ', scope: null },
    ]
    for (const [index, input] of inputs.entries()) {
      const recipient = `direct-${index}@example.test`
      const invitation = await account.invitations.send({
        actorId: actor.id,
        email: ` ${recipient.toUpperCase()} `,
        ...input,
      })
      assert.deepInclude(invitation, {
        email: recipient,
        role: input.role,
        scope: input.scope ?? null,
      })
    }
    assert.deepEqual(
      invites.map(({ role, scope }) => ({ role, scope })),
      inputs.flatMap(({ role, scope }) => Array(2).fill({ role, scope: scope ?? null }))
    )

    for (const [input, field] of [
      [{ role: '' }, 'role'],
      [{ role: 'r'.repeat(65) }, 'role'],
      [{ role: ` ${maxRole} ` }, 'role'],
      [{ role: 'r', scope: '' }, 'scope'],
      [{ role: 'r', scope: 's'.repeat(256) }, 'scope'],
    ] as const) {
      const error = await account.invitations
        .send({ actorId: actor.id, email, ...input })
        .catch((failure: unknown) => failure)
      assert.instanceOf(error, E_ACCOUNT_KIT_INVALID_INPUT)
      assert.deepInclude(error as InstanceType<typeof E_ACCOUNT_KIT_INVALID_INPUT>, {
        message: `Invalid ${field}`,
        code: 'E_ACCOUNT_KIT_INVALID_INPUT',
        status: 422,
      })
    }

    const first = await account.invitations.list({ actorId: actor.id, limit: 1 })
    assert.lengthOf(first.items, 1)
    const filtered = await account.invitations.list({
      actorId: actor.id,
      limit: 100,
      scope: maxScope,
    })
    assert.lengthOf(filtered.items, 1)
    const unscoped = await account.invitations.list({ actorId: actor.id, scope: null })
    assert.lengthOf(unscoped.items, 2)
    for (const limit of [0, 101, 1.5]) {
      const error = await account.invitations
        .list({ actorId: actor.id, limit })
        .catch((failure: unknown) => failure)
      assert.instanceOf(error, E_ACCOUNT_KIT_INVALID_INPUT)
      assert.deepInclude(error as InstanceType<typeof E_ACCOUNT_KIT_INVALID_INPUT>, {
        message: 'Invalid invitation page limit',
        code: 'E_ACCOUNT_KIT_INVALID_INPUT',
        status: 422,
      })
    }
    assert.deepEqual(lists, [{}, { scope: maxScope }, { scope: null }])
    assert.lengthOf(invites, 8)
    assert.lengthOf(await kit.db.from('account_invitations'), 4)
  })

  test('managed invitation routes validate inputs before calling the service', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account, invites, lists } = setup({
      authentication: { strategy: 'session', guard: 'web' },
    })
    const { router, routes, context } = fakeManagedHttp()
    new ManagedRoutes().register(router, {
      prefix: '/api/v1',
      kit: async () => account,
      guard: stubGuard({ current: async () => ({ userId: actor.id, revision: null }) }),
      enabled: ['invitations'],
      verificationRequired: false,
    })
    async function call(method: 'GET' | 'POST', data: Record<string, unknown>) {
      const ctx = context()
      const request = requestWithHeaders()
      if (method === 'GET') request.updateQs(data)
      else request.updateBody(data)
      ctx.request = request
      const validator = new RequestValidator(ctx)
      Object.assign(request, {
        csrfToken: 'proof',
        validateUsing: validator.validateUsing.bind(validator),
      })
      return routes.get(`${method} /api/v1/account/invitations`)!(ctx) as Promise<{
        status: number
        body: { items: Array<{ scope: string | null }> }
      }>
    }

    const maxRole = 'r'.repeat(64)
    const maxScope = 's'.repeat(255)
    const inputs = [
      { role: ' r ', scope: ' ' },
      { role: ` ${maxRole} `, scope: maxScope },
      { role: 'guest' },
      { role: ' guest ', scope: null },
    ]
    for (const [index, input] of inputs.entries()) {
      const sent = await call('POST', { email: ` MANAGED-${index}@example.test `, ...input })
      assert.equal(sent.status, 201)
    }
    const rows = await kit.db
      .from('account_invitations')
      .select('email', 'role', 'scope')
      .orderBy('id')
    assert.deepEqual(
      rows,
      inputs.map(({ role, scope }, index) => ({
        email: `managed-${index}@example.test`,
        role: role.trim(),
        scope: scope ?? '',
      }))
    )
    assert.deepEqual(
      invites.map(({ role, scope }) => ({ role, scope })),
      inputs.flatMap(({ role, scope }) =>
        Array(2).fill({ role: role.trim(), scope: scope ?? null })
      )
    )

    for (const [method, input, field] of [
      ['POST', { role: ' ' }, 'role'],
      ['POST', { role: 'r'.repeat(65) }, 'role'],
      ['POST', { role: 'r', scope: '' }, 'scope'],
      ['POST', { role: 'r', scope: 's'.repeat(256) }, 'scope'],
      ['GET', { limit: '0' }, 'limit'],
      ['GET', { limit: '101' }, 'limit'],
      ['GET', { limit: '1.5' }, 'limit'],
    ] as const) {
      const data = method === 'POST' ? { email, ...input } : input
      const error = await call(method, data).catch((failure: unknown) => failure)
      assert.deepInclude(error as object, { status: 422, code: 'E_VALIDATION_ERROR' })
      assert.deepEqual(
        (error as { messages: Array<{ field: string }> }).messages.map((message) => message.field),
        [field]
      )
    }

    const first = await call('GET', { limit: '1' })
    assert.equal(first.status, 200)
    assert.lengthOf(first.body.items, 1)
    const filtered = await call('GET', { limit: '100', scope: maxScope })
    assert.equal(filtered.status, 200)
    assert.deepEqual(
      filtered.body.items.map((item) => item.scope),
      [maxScope]
    )
    const all = await call('GET', {})
    assert.equal(all.status, 200)
    assert.lengthOf(all.body.items, 4)
    assert.deepEqual(lists, [{}, { scope: maxScope }, {}])
    assert.lengthOf(invites, 8)
    assert.lengthOf(await kit.db.from('account_invitations'), 4)
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
