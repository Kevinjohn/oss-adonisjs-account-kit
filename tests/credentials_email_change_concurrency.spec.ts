import { test } from '@japa/runner'
import { IdentityNotConfirmedError, ThrottledError } from '../src/errors.js'
import { useTestApp } from './helpers/app.js'
import { makeUsersAdapter } from './helpers/fakes.js'
import { credentialsFixtures } from './helpers/credentials.js'
import { locksRows, lockNotAvailableCode } from './helpers/dialect.js'
test.group('emailPasswordManagement', (group) => {
  const kit = useTestApp(group)
  const { createUser, service } = credentialsFixtures(kit)

  test('request and password change share the identity throttle before lookup or proof', async ({
    assert,
  }) => {
    const user = await createUser()
    const users = makeUsersAdapter(kit.db, kit.hash)
    let lookups = 0
    let proofs = 0
    const account = service({
      users: {
        ...users,
        async findById(...args) {
          lookups++
          return users.findById(...args)
        },
        async verifyPassword(...args) {
          proofs++
          return users.verifyPassword(...args)
        },
      },
    })
    for (let index = 0; index < 5; index++)
      await assert.rejects(
        () =>
          account.emailPasswordManagement.changePassword({
            actorId: user.id,
            currentPassword: 'wrong',
            newPassword: 'newPassword123',
          }),
        IdentityNotConfirmedError
      )
    try {
      await account.emailPasswordManagement.requestEmailChange({
        actorId: user.id,
        currentPassword: 'oldPassword123',
        newEmail: 'new@example.test',
      })
      assert.fail('expected throttle')
    } catch (error) {
      assert.instanceOf(error, ThrottledError)
      assert.isAbove((error as ThrottledError).retryAfterSeconds, 0)
    }
    assert.equal(lookups, 5)
    assert.equal(proofs, 5)
    assert.lengthOf(await kit.db.from('email_verification_tokens'), 0)
  })

  test('request holds the actor lock through the password proof', async ({ assert }) => {
    const user = await createUser()
    const users = makeUsersAdapter(kit.db, kit.hash)
    let proofReady!: () => void
    let releaseProof!: () => void
    const ready = new Promise<void>((resolve) => {
      proofReady = resolve
    })
    const hold = new Promise<void>((resolve) => {
      releaseProof = resolve
    })
    const account = service({
      users: {
        ...users,
        async verifyPassword(...args) {
          const valid = await users.verifyPassword(...args)
          proofReady()
          await hold
          return valid
        },
      },
    })
    const sqliteClient = locksRows ? null : kit.db.connection().getWriteClient()
    const native = sqliteClient
      ? ((await sqliteClient.client.acquireConnection()) as {
          pragma: (statement: string, options: { simple: true }) => number | string
          prepare: (statement: string) => { run: (id: string | number) => void }
        })
      : null
    if (native) assert.equal(native.pragma('journal_mode', { simple: true }), 'wal')
    const requesting = account.emailPasswordManagement.requestEmailChange({
      actorId: user.id,
      currentPassword: 'oldPassword123',
      newEmail: 'new@example.test',
    })
    try {
      await ready
      let conflict: unknown
      try {
        if (locksRows) {
          await kit.db.transaction((trx) =>
            trx.rawQuery('SELECT id FROM users WHERE id = ? FOR UPDATE NOWAIT', [user.id]).exec()
          )
        } else {
          const prior = native!.pragma('busy_timeout', { simple: true })
          try {
            native!.pragma('busy_timeout = 0', { simple: true })
            native!.prepare('UPDATE users SET id = id WHERE id = ?').run(user.id)
          } finally {
            native!.pragma(`busy_timeout = ${prior}`, { simple: true })
          }
        }
      } catch (error) {
        conflict = error
      }
      assert.equal((conflict as { code?: string } | undefined)?.code, lockNotAvailableCode)
    } finally {
      releaseProof()
      await requesting.catch(() => {})
      if (native) await sqliteClient!.client.releaseConnection(native)
    }
  })
})
