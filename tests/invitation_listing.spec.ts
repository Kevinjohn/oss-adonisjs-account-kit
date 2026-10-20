import { test } from '@japa/runner'
import { InvalidInputError } from '../src/errors.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService, makeUsersAdapter } from './helpers/fakes.js'
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
})
