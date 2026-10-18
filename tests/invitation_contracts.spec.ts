import { test } from '@japa/runner'
import {
  InvalidInputError,
  InvitationManagementDeniedError,
  InvitationNotFoundError,
} from '../src/errors.js'
import type { UsersAdapter } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { allowAll, insertUser, makeService, makeUsersAdapter, tokenFrom } from './helpers/fakes.js'
import { dbTime } from './helpers/db_time.js'

test.group('invitation management contracts', (group) => {
  const kit = useTestApp(group)

  test('pages equal timestamps in id order without repeats', async ({ assert }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account } = makeService(kit)
    const sent = []
    for (let n = 0; n < 5; n++) {
      sent.push(
        await account.invitations.send({
          actorId: actor.id,
          email: `person${n}@example.test`,
          role: 'user',
        })
      )
    }
    await kit.db
      .from('account_invitations')
      .update({ created_at: dbTime(kit, '2026-01-01T00:00:00.000Z') })
    const found: number[] = []
    let cursor: string | null = null
    do {
      const page = await account.invitations.list({
        actorId: actor.id,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      })
      found.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
    } while (cursor)
    assert.deepEqual(
      found,
      sent.map((item) => item.id)
    )
  })

  test('pages only unexpired invitations in order when expired rows are interleaved', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account } = makeService(kit)
    const sent = []
    for (let n = 0; n < 5; n++) {
      sent.push(
        await account.invitations.send({
          actorId: actor.id,
          email: `person${n}@example.test`,
          role: 'user',
        })
      )
    }
    await kit.db
      .from('account_invitations')
      .update({ created_at: dbTime(kit, '2026-01-01T00:00:00.000Z') })
    await kit.db
      .from('account_invitations')
      .whereIn('id', [sent[1].id, sent[3].id])
      .update({ expires_at: dbTime(kit, '2020-01-01T00:00:00.000Z') })

    const found: number[] = []
    let cursor: string | null = null
    do {
      const page = await account.invitations.list({
        actorId: actor.id,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      })
      found.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
    } while (cursor)

    assert.deepEqual(found, [sent[0].id, sent[2].id, sent[4].id])
  })

  test('rejects malformed cursors and excessive limits', async ({ assert }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account } = makeService(kit)
    await assert.rejects(
      () => account.invitations.list({ actorId: actor.id, limit: 101 }),
      InvalidInputError
    )
    await assert.rejects(
      () => account.invitations.list({ actorId: actor.id, cursor: 'invalid' }),
      InvalidInputError
    )
    await assert.rejects(
      () => account.invitations.list({ actorId: actor.id, cursor: 'a'.repeat(513) }),
      InvalidInputError
    )
  })

  test('rejects oversized cursors before decoding or actor lookup', async ({ assert }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const users = makeUsersAdapter(kit.db, kit.hash)
    let actorReads = 0
    const { account } = makeService(kit, {
      users: {
        ...users,
        async findById(...args) {
          actorReads++
          return users.findById(...args)
        },
      },
    })
    const cursor = 'oversized-cursor-' + 'a'.repeat(513)
    const originalFrom = Buffer.from
    let decoded = false
    Buffer.from = ((value: Parameters<typeof Buffer.from>[0], ...args: unknown[]) => {
      if (value === cursor) decoded = true
      return originalFrom(value as never, ...(args as [never]))
    }) as typeof Buffer.from
    try {
      await assert.rejects(
        () => account.invitations.list({ actorId: actor.id, cursor }),
        InvalidInputError
      )
    } finally {
      Buffer.from = originalFrom
    }
    assert.isFalse(decoded)
    assert.equal(actorReads, 0)
  })

  test('distinguishes missing and denied management internally', async ({ assert }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const { account } = makeService(kit)
    const invitation = await account.invitations.send({
      actorId: actor.id,
      email: 'invitee@example.test',
      role: 'user',
    })
    await assert.rejects(
      () => account.invitations.revoke({ actorId: actor.id, invitationId: 99999 }),
      InvitationNotFoundError
    )
    const denied = makeService(kit, {
      authorize: { ...allowAll, manageInvitation: async () => false },
    }).account
    await assert.rejects(
      () => denied.invitations.revoke({ actorId: actor.id, invitationId: invitation.id }),
      InvitationManagementDeniedError
    )
  })

  test('malformed management ids fail before actor lookup, policy, budgets or writes', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const base = makeUsersAdapter(kit.db, kit.hash)
    let actorReads = 0
    let policyReads = 0
    const { account, recorder } = makeService(kit, {
      users: {
        ...base,
        async findById(...args) {
          actorReads++
          return base.findById(...args)
        },
      },
      authorize: {
        ...allowAll,
        async manageInvitation() {
          policyReads++
          return true
        },
      },
      invitationThrottle: { resendActor: { requests: 1, duration: '1h' } },
    })
    const invitation = await account.invitations.send({
      actorId: actor.id,
      email: 'invitee@example.test',
      role: 'user',
    })
    const originalRow = await kit.db.from('account_invitations').where('id', invitation.id).first()
    const tokenHash = originalRow.token_hash
    actorReads = 0
    for (const bad of [
      Number.NaN,
      Infinity,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      'abc',
      '1',
      null,
    ]) {
      for (const operation of ['resend', 'revoke'] as const) {
        await assert.rejects(
          () => account.invitations[operation]({ actorId: actor.id, invitationId: bad as number }),
          InvalidInputError
        )
      }
    }
    assert.equal(actorReads, 0)
    assert.equal(policyReads, 0)
    assert.lengthOf(recorder.calls, 1)
    const unchanged = await kit.db.from('account_invitations').where('id', invitation.id).first()
    assert.equal(unchanged.token_hash, tokenHash)
    await account.invitations.resend({ actorId: actor.id, invitationId: invitation.id })
    assert.lengthOf(recorder.calls, 2)
  })

  test('validated registration data reaches the adapter and invalid data preserves the invitation', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const users = makeUsersAdapter(kit.db, kit.hash)
    let savedName: string | null = null
    const validating: UsersAdapter = {
      ...users,
      async create(attrs, trx) {
        const data = attrs.registrationData
        if (
          !data ||
          typeof data !== 'object' ||
          Array.isArray(data) ||
          Object.keys(data).some((key) => key !== 'fullName') ||
          typeof (data as { fullName?: unknown }).fullName !== 'string' ||
          !(data as { fullName: string }).fullName.trim()
        ) {
          throw new InvalidInputError('Invalid registration data')
        }
        const created = await users.create(attrs, trx)
        savedName = (data as { fullName: string }).fullName
        return created
      },
    }
    const { account, recorder } = makeService(kit, {
      users: validating,
      registration: {
        availability: 'closed',
        mapFields: (input) => input as Record<string, unknown>,
      },
    })
    const invitation = await account.invitations.send({
      actorId: actor.id,
      email: 'invitee@example.test',
      role: 'user',
    })
    const token = tokenFrom(recorder.calls.at(-1)!.args[1])
    await assert.rejects(
      () => account.invitations.accept({ token, password: 'password123' }),
      InvalidInputError
    )
    await assert.rejects(
      () =>
        account.invitations.accept({
          token,
          password: 'password123',
          registrationData: { fullName: 'Person', role: 'admin' },
        }),
      InvalidInputError
    )
    assert.isNotNull(await kit.db.from('account_invitations').where('id', invitation.id).first())
    assert.lengthOf(await kit.db.from('users').where('email', invitation.email), 0)
    const created = await account.invitations.accept({
      token,
      password: 'password123',
      registrationData: { fullName: 'Person' },
    })
    assert.equal(created.email, invitation.email)
    assert.equal(savedName, 'Person')
  })

  test('unmapped or protected invitation fields never reach a permissive adapter', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const users = makeUsersAdapter(kit.db, kit.hash)
    let createCalls = 0
    const permissive: UsersAdapter = {
      ...users,
      async create(attrs, trx) {
        createCalls++
        return users.create(attrs, trx)
      },
    }
    const { account, recorder } = makeService(kit, {
      users: permissive,
      registration: {
        availability: 'closed',
        mapFields: (input) => input as Record<string, unknown>,
      },
    })
    await account.invitations.send({
      actorId: actor.id,
      email: 'invitee@example.test',
      role: 'user',
    })
    const token = tokenFrom(recorder.calls.at(-1)!.args[1])
    await assert.rejects(
      () =>
        account.invitations.accept({
          token,
          password: 'password123',
          registrationData: { role: 'admin' },
        }),
      InvalidInputError
    )
    assert.equal(createCalls, 0)
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
  })

  test('invitation fields without a configured mapper are rejected before creation', async ({
    assert,
  }) => {
    const actor = await insertUser(kit, { email: 'actor@example.test' })
    const users = makeUsersAdapter(kit.db, kit.hash)
    let createCalls = 0
    const { account, recorder } = makeService(kit, {
      users: {
        ...users,
        async create(attrs, trx) {
          createCalls++
          return users.create(attrs, trx)
        },
      },
      registration: { availability: 'closed' },
    })
    await account.invitations.send({
      actorId: actor.id,
      email: 'invitee@example.test',
      role: 'user',
    })
    const token = tokenFrom(recorder.calls.at(-1)!.args[1])
    await assert.rejects(
      () =>
        account.invitations.accept({
          token,
          password: 'password123',
          registrationData: { role: 'admin' },
        }),
      InvalidInputError
    )
    assert.equal(createCalls, 0)
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
  })
})
