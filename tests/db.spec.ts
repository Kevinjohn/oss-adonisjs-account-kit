import { test } from '@japa/runner'
import { bootTestApp } from './helpers/app.js'
import { resetSchema } from './helpers/schema.js'
import { lockUser, transaction } from '../src/db.js'
import { isUniqueViolation } from '../src/db.js'

test.group('database helpers', (group) => {
  let kit: Awaited<ReturnType<typeof bootTestApp>>

  group.setup(async () => {
    kit = await bootTestApp()
  })

  group.each.setup(async () => {
    await resetSchema(kit)
    await kit.limiter.clear()
  })

  group.teardown(async () => {
    await kit.close()
  })

  test('recognizes a real duplicate users.email violation on each database', async ({ assert }) => {
    await kit.db.table('users').insert({ email: 'duplicate@example.test', created_at: new Date() })
    let duplicateError: unknown
    try {
      await kit.db
        .table('users')
        .insert({ email: 'duplicate@example.test', created_at: new Date() })
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
      await lockUser(trx, id)
      await trx.from('users').where('id', id).update({ password: 'committed' })
      firstLocked()
      await firstHold
    })
    await firstReady

    let secondFinished = false
    let secondPassword: string | undefined
    const second = transaction(kit.db, async (trx) => {
      await lockUser(trx, id)
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
})
