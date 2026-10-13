import { test } from '@japa/runner'
import { lockRow, transaction } from '../src/db.js'
import { isUniqueViolation } from '../src/db.js'
import { useTestApp } from './helpers/app.js'
import { resetSchema } from './helpers/schema.js'
test.group('database helpers', (group) => {
  const kit = useTestApp(group)

  test('recognizes a real duplicate users.email violation on each database', async ({ assert }) => {
    const email = 'duplicate@example.test - UNIQUE constraint failed: users.email_alias'
    await kit.db.table('users').insert({ email, created_at: new Date() })
    let duplicateError: unknown
    try {
      await kit.db.table('users').insert({ email, created_at: new Date() })
      assert.fail('expected the unique index to reject a duplicate email')
    } catch (error) {
      duplicateError = error
    }

    assert.isTrue(isUniqueViolation(duplicateError, 'users', 'email'))
    assert.isFalse(isUniqueViolation(duplicateError, 'users', 'password'))
    assert.isFalse(isUniqueViolation(new Error('unrelated failure'), 'users', 'email'))
    assert.isFalse(
      isUniqueViolation(
        { code: '23505', constraint: 'users_password_unique', message: 'duplicate' },
        'users',
        'email'
      )
    )
    assert.isFalse(
      isUniqueViolation(
        { code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'UNIQUE constraint failed: users.password' },
        'users',
        'email'
      )
    )
  })

  test('blocks a second SQLite transaction until the locked user commits', async ({ assert }) => {
    if (process.env.DB_CLIENT === 'pg') return

    await kit.db.table('users').insert({
      email: 'locked@example.test',
      password: 'before',
      created_at: new Date(),
    })
    const { id } = await kit.db.from('users').where('email', 'locked@example.test').first()

    let firstLocked!: () => void
    let releaseFirst!: () => void
    const firstReady = new Promise<void>((resolve) => {
      firstLocked = resolve
    })
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = transaction(kit.db, async (trx) => {
      await lockRow(trx, 'users', id)
      await trx.from('users').where('id', id).update({ password: 'committed' })
      firstLocked()
      await firstHold
    })
    await firstReady

    let secondFinished = false
    let secondPassword: string | undefined
    const second = transaction(kit.db, async (trx) => {
      await lockRow(trx, 'users', id)
      const row = await trx.from('users').where('id', id).first()
      secondPassword = row.password
      secondFinished = true
    })

    await new Promise((resolve) => setTimeout(resolve, 40))
    const secondWaitedForLock = !secondFinished
    releaseFirst()
    await Promise.all([first, second])

    assert.isTrue(secondWaitedForLock)
    assert.equal(secondPassword, 'committed')
  })

  test('locks rows in the configured users table name on SQLite', async ({ assert }) => {
    if (process.env.DB_CLIENT === 'pg') return

    const schema = kit.db.connection().schema
    await schema.dropTableIfExists('account_email_changes')
    await schema.dropTableIfExists('account_invitations')
    await schema.dropTableIfExists('account_recovery_tokens')
    await schema.dropTableIfExists('users')
    await schema.dropTableIfExists('accounts')
    await schema.createTable('accounts', (table) => {
      table.increments('id')
      table.string('email').notNullable().unique()
    })
    try {
      await kit.db.table('accounts').insert({ email: 'renamed@example.test' })
      const { id } = await kit.db.from('accounts').where('email', 'renamed@example.test').first()
      await transaction(kit.db, async (trx) => {
        await lockRow(trx, 'accounts', id)
        const client = kit.db.connection().getWriteClient().client
        const peer = await client.acquireConnection()
        const timeout = peer.pragma('busy_timeout', { simple: true })
        let conflict: unknown
        try {
          peer.pragma('busy_timeout = 0')
          try {
            peer.prepare('UPDATE "accounts" SET id = id WHERE id = ?').run(id)
          } catch (error) {
            conflict = error
          }
        } finally {
          peer.pragma(`busy_timeout = ${timeout}`)
          await client.releaseConnection(peer)
        }
        assert.equal((conflict as { code?: string } | undefined)?.code, 'SQLITE_BUSY')
      })
    } finally {
      await schema.dropTableIfExists('accounts')
      await resetSchema(kit)
    }
  })

  test('does not confuse an email-prefixed unique column with users.email', async ({ assert }) => {
    await kit.db.connection().schema.alterTable('users', (table) => {
      table.string('email_alias').unique()
    })
    group.each.teardown(() => resetSchema(kit))
    await kit.db.table('users').insert({
      email: 'first@example.test',
      email_alias: 'same-alias',
      created_at: new Date(),
    })
    let failure: unknown
    try {
      await kit.db.table('users').insert({
        email: 'second@example.test',
        email_alias: 'same-alias',
        created_at: new Date(),
      })
    } catch (error) {
      failure = error
    }
    assert.isDefined(failure)
    assert.isFalse(isUniqueViolation(failure, 'users', 'email'))
  })

  test('recognizes only the documented PostgreSQL email constraint identity', ({ assert }) => {
    assert.isTrue(
      isUniqueViolation({ code: '23505', constraint: 'users_email_unique' }, 'users', 'email')
    )
    assert.isFalse(
      isUniqueViolation({ code: '23505', constraint: 'users_email_key' }, 'users', 'email')
    )
    assert.isFalse(
      isUniqueViolation({ code: '23505', constraint: 'other_users_email_unique' }, 'users', 'email')
    )
  })
})
