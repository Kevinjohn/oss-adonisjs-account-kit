import { test } from '@japa/runner'
import { InvalidInputError } from '../src/errors.js'
import type { UsersAdapter } from '../src/types.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeService, makeUsersAdapter, tokenFrom } from './helpers/fakes.js'

test.group('invitation management contracts', (group) => {
  const kit = useTestApp(group)

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
