import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { AuthorizationError, InvalidInputError } from '../src/errors.js'
import { hashToken } from '../src/tokens.js'
import type { AccountKitConfig } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { allowAll, insertUser, makeService, tokenFrom } from './helpers/fakes.js'

test.group('invitations.list and inspect', (group) => {
  const kit = useTestApp(group)

  const createActor = (email = 'actor@example.test') => insertUser(kit, { email })

  const service = (overrides: Partial<AccountKitConfig> = {}) => makeService(kit, overrides)

  test('lists only live invitations in creation order without token material', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account } = service()
    const first = await account.invitations.send({
      actorId: actor.id,
      email: 'first@example.test',
      role: 'user',
    })
    const second = await account.invitations.send({
      actorId: actor.id,
      email: 'second@example.test',
      role: 'admin',
    })
    const expired = await account.invitations.send({
      actorId: actor.id,
      email: 'expired@example.test',
      role: 'user',
    })
    await kit.db
      .from('account_invitations')
      .where('id', first.id)
      .update({ created_at: DateTime.utc().minus({ days: 2 }).toISO() })
    await kit.db
      .from('account_invitations')
      .where('id', second.id)
      .update({ created_at: DateTime.utc().minus({ days: 1 }).toISO() })
    await kit.db
      .from('account_invitations')
      .where('id', expired.id)
      .update({ expires_at: DateTime.utc().minus({ seconds: 1 }).toISO() })
    const listed = await account.invitations.list({ actorId: actor.id })
    assert.deepEqual(
      listed.items.map((item) => item.id),
      [first.id, second.id]
    )
    assert.equal(listed.items[0].email, first.email)
    assert.equal(listed.items[1].role, second.role)
    assert.isNull(listed.nextCursor)
    assert.isUndefined((listed.items[0] as never as { tokenHash?: string }).tokenHash)
  })

  test('list requires a known actor and exact true authorization', async ({ assert }) => {
    const actor = await createActor()
    const { account } = service({
      authorize: { ...allowAll, listInvitations: async () => undefined as never },
    })
    await assert.rejects(() => account.invitations.list({ actorId: 99999 }), InvalidInputError)
    await assert.rejects(() => account.invitations.list({ actorId: actor.id }), AuthorizationError)
  })

  test('inspect reveals only the live email and role without consuming the token', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    await account.invitations.send({
      actorId: actor.id,
      email: '  PERSON@EXAMPLE.TEST ',
      role: 'admin',
    })
    const raw = tokenFrom(recorder.calls[0].args[1])
    const expected = { email: 'person@example.test', role: 'admin' }
    assert.deepEqual(await account.invitations.inspect({ token: raw }), expected)
    assert.deepEqual(await account.invitations.inspect({ token: raw }), expected)
    const row = await kit.db.from('account_invitations').where('token_hash', hashToken(raw)).first()
    assert.isNotNull(row)
  })

  test('inspect returns null for malformed, unknown, and expired tokens without mutating rows', async ({
    assert,
  }) => {
    const actor = await createActor()
    const { account, recorder } = service()
    await account.invitations.send({ actorId: actor.id, email: 'new@example.test', role: 'user' })
    const raw = tokenFrom(recorder.calls[0].args[1])
    for (const value of [null, 42, '', 'invalid'])
      assert.isNull(await account.invitations.inspect({ token: value as never }))
    assert.isNull(await account.invitations.inspect({ token: 'a'.repeat(43) }))
    await kit.db
      .from('account_invitations')
      .where('token_hash', hashToken(raw))
      .update({ expires_at: DateTime.utc().minus({ seconds: 1 }).toISO() })
    assert.isNull(await account.invitations.inspect({ token: raw }))
    assert.lengthOf(await kit.db.from('account_invitations'), 1)
  })
})
