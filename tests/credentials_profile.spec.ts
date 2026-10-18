import { test } from '@japa/runner'
import { EmailAlreadyRegisteredError, InvalidInputError } from '../src/errors.js'
import { useTestApp } from './helpers/app.js'
import { insertUser, makeNotify, makeUsersAdapter, tokenFrom } from './helpers/fakes.js'
import { credentialsFixtures } from './helpers/credentials.js'
test.group('emailPasswordManagement', (group) => {
  const kit = useTestApp(group)
  const { createUser, service } = credentialsFixtures(kit)

  test('profile updates map only configured fields and preserve pending email when omitted', async ({
    assert,
  }) => {
    const user = await createUser()
    const users = makeUsersAdapter(kit.db, kit.hash)
    const received: Array<Record<string, unknown>> = []
    const recorder = makeNotify()
    const account = service({
      notify: recorder.notify,
      users: {
        ...users,
        async updateRegistrationData(_id, data) {
          received.push(data)
        },
      },
      registration: {
        availability: 'closed',
        mapFields: (input) => ({ fullName: (input as { name: string }).name }),
      },
    })
    const updated = await account.emailPasswordManagement.updateProfile({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      registrationData: { name: 'Person', role: 'admin' },
    })
    assert.equal(updated.email, user.email)
    assert.deepEqual(received, [{ fullName: 'Person' }])
    assert.lengthOf(recorder.calls, 0)
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isNull(row.unverified_email)
    const pending = await account.emailPasswordManagement.updateProfile({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      email: 'new@example.test',
      registrationData: { name: 'Another Person' },
    })
    assert.equal(pending.email, user.email)
    assert.equal(pending.unverifiedEmail, 'new@example.test')
    assert.deepEqual(received, [{ fullName: 'Person' }, { fullName: 'Another Person' }])
    assert.equal(recorder.calls[0].method, 'emailChangeProvision')
    const pendingToken = tokenFrom(recorder.calls[0].args[2])
    const profileOnly = await account.emailPasswordManagement.updateProfile({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      registrationData: { name: 'Third Person' },
    })
    assert.equal(profileOnly.unverifiedEmail, 'new@example.test')
    assert.isTrue(await account.emailPasswordManagement.inspectEmailChange({ token: pendingToken }))
    assert.lengthOf(recorder.calls, 1)
    assert.deepEqual(received.at(-1), { fullName: 'Third Person' })
  })

  test('a later email conflict rolls back a persisted profile field and preserves pending proof', async ({
    assert,
  }) => {
    const user = await createUser()
    await kit.db.connection().schema.alterTable('users', (table) => table.string('display_name'))
    await kit.db.from('users').where('id', user.id).update({ display_name: 'Original' })
    await insertUser(kit, { email: 'taken@example.test' })
    const users = makeUsersAdapter(kit.db, kit.hash)
    let profileWrites = 0
    const recorder = makeNotify()
    const account = service({
      notify: recorder.notify,
      users: {
        ...users,
        async updateRegistrationData(id, data, trx) {
          profileWrites++
          await trx.from('users').where('id', id).update({ display_name: data.displayName })
        },
      },
      registration: {
        availability: 'closed',
        mapFields: (input) => ({ displayName: (input as { name: string }).name }),
      },
    })
    await account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newEmail: 'pending@example.test',
    })
    const pendingToken = tokenFrom(recorder.calls[0].args[2])
    const before = await kit.db
      .from('email_verification_tokens')
      .where('tokenable_id', user.id)
      .first()
    await assert.rejects(
      () =>
        account.emailPasswordManagement.updateProfile({
          actorId: user.id,
          currentPassword: 'oldPassword123',
          email: 'taken@example.test',
          registrationData: { name: 'Attempted' },
        }),
      EmailAlreadyRegisteredError
    )
    assert.equal(profileWrites, 1)
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.equal(row.display_name, 'Original')
    assert.equal(row.unverified_email, 'pending@example.test')
    assert.deepEqual(
      await kit.db.from('email_verification_tokens').where('tokenable_id', user.id).first(),
      before
    )
    assert.isTrue(await account.emailPasswordManagement.inspectEmailChange({ token: pendingToken }))
    assert.lengthOf(recorder.calls, 1)
  })

  test('profile field failure rolls back a simultaneous pending-address request', async ({
    assert,
  }) => {
    const user = await createUser()
    const users = makeUsersAdapter(kit.db, kit.hash)
    const account = service({
      users: {
        ...users,
        async updateRegistrationData(_id, _data, trx) {
          await trx.from('users').where('id', user.id).update({ email_verified_at: null })
          throw new Error('profile write failed')
        },
      },
      registration: {
        availability: 'closed',
        mapFields: () => ({ fullName: 'Person' }),
      },
    })
    await assert.rejects(
      () =>
        account.emailPasswordManagement.updateProfile({
          actorId: user.id,
          currentPassword: 'oldPassword123',
          email: 'new@example.test',
          registrationData: { name: 'Person' },
        }),
      /profile write failed/
    )
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.equal(row.email, user.email)
    assert.isNull(row.unverified_email)
    assert.isNotNull(row.email_verified_at)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
  })

  test('profile writes reject unconfigured and protected fields before adapter writes', async ({
    assert,
  }) => {
    const user = await createUser()
    const users = makeUsersAdapter(kit.db, kit.hash)
    let writes = 0
    const adapter = {
      ...users,
      async updateRegistrationData() {
        writes++
      },
    }
    const account = service({ users: adapter })
    await assert.rejects(
      () =>
        account.emailPasswordManagement.updateProfile({
          actorId: user.id,
          currentPassword: 'oldPassword123',
          registrationData: { role: 'admin' },
        }),
      InvalidInputError
    )
    const configured = service({
      users: adapter,
      registration: {
        availability: 'closed',
        mapFields: () => ({ role: 'admin' }),
      },
    })
    await assert.rejects(
      () =>
        configured.emailPasswordManagement.updateProfile({
          actorId: user.id,
          currentPassword: 'oldPassword123',
          registrationData: { fullName: 'Person' },
        }),
      InvalidInputError
    )
    const required = service({
      users: adapter,
      registration: {
        availability: 'closed',
        mapFields: (input) => {
          if (input === undefined) throw new InvalidInputError('Full name is required')
          return { fullName: (input as { fullName: string }).fullName }
        },
      },
    })
    await assert.rejects(
      () =>
        required.emailPasswordManagement.updateProfile({
          actorId: user.id,
          currentPassword: 'oldPassword123',
          email: 'new@example.test',
          registrationData: undefined,
        }),
      /Full name is required/
    )
    assert.equal(writes, 0)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
  })
})
