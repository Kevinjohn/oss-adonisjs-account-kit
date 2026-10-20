import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { defineConfig } from '../src/account_kit.js'
import { generateToken, hashToken } from '../src/tokens.js'
import { useTestApp } from './helpers/app.js'
import { accountKit, makeConfig, makeNotify, makeUsersAdapter, tokenFrom } from './helpers/fakes.js'
import { dbTime } from './helpers/db_time.js'

test.group('passwordReset.inspect', (group) => {
  const kit = useTestApp(group)

  async function issue() {
    const users = makeUsersAdapter(kit.db, kit.hash)
    await kit.db.transaction((trx) =>
      users.create(
        {
          email: 'person@example.test',
          password: 'password123',
          unverifiedEmail: null,
        },
        trx
      )
    )
    const recorder = makeNotify()
    const config = defineConfig(makeConfig({ users, notify: recorder.notify, minRequestMs: 0 }))
    const account = accountKit(kit, config)
    await account.passwordReset.request({ email: 'person@example.test', clientKey: 'first' })
    const token = tokenFrom(recorder.calls[0].args[1])
    return { account, token }
  }

  test('valid token remains valid on repeated inspection without consumption', async ({
    assert,
  }) => {
    const { account, token } = await issue()
    assert.isTrue(await account.passwordReset.inspect({ token }))
    assert.isTrue(await account.passwordReset.inspect({ token }))
    const rows = await kit.db.from('password_reset_tokens')
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].hash, hashToken(token))
  })

  test('inspection rejects a proof after the account address changes', async ({ assert }) => {
    const { account, token } = await issue()
    await kit.db.from('users').update({ email: 'replacement@example.test' })
    assert.isFalse(await account.passwordReset.inspect({ token }))
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
  })

  test('expired token is rejected', async ({ assert }) => {
    const { account, token } = await issue()
    await kit.db.from('password_reset_tokens').update({
      expires_at: dbTime(kit, DateTime.utc().minus({ minutes: 1 })),
    })
    assert.isFalse(await account.passwordReset.inspect({ token }))
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
  })

  test('unknown and malformed tokens return false before malformed values reach hashing or the database', async ({
    assert,
  }) => {
    const { account } = await issue()
    assert.isFalse(await account.passwordReset.inspect({ token: generateToken() }))
    for (const token of [null, undefined, 42, {}, [], '', 'a'.repeat(42), '!'.repeat(43)]) {
      assert.isFalse(await account.passwordReset.inspect({ token: token as never }))
    }
    assert.lengthOf(await kit.db.from('password_reset_tokens'), 1)
  })
})
