import { test } from '@japa/runner'
import { lockRow, transaction } from '../src/db.js'
import { useTestApp } from './helpers/app.js'
import { resetSchema } from './helpers/schema.js'
import { locksRows } from './helpers/dialect.js'

test.group('database helpers', (group) => {
  const kit = useTestApp(group)

  test('serializes a second SQLite transaction until the first writer commits', async ({
    assert,
  }) => {
    if (locksRows) return

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
    await Promise.race([
      firstReady,
      first.then(() => {
        throw new Error('The first SQLite transaction completed before the lock probe started')
      }),
    ]).catch((error: unknown) => {
      releaseFirst()
      throw error
    })

    let client:
      | {
          on(
            event: 'query-error',
            listener: (error: unknown, query: { sql?: string }) => void
          ): void
          off(
            event: 'query-error',
            listener: (error: unknown, query: { sql?: string }) => void
          ): void
        }
      | undefined
    let observeBusy!: () => void
    let failBusy!: (error: Error) => void
    let busyObserved = false
    const busy = new Promise<void>((resolve, reject) => {
      observeBusy = resolve
      failBusy = reject
    })
    void busy.catch(() => {})
    const onQueryError = (error: unknown, query: { sql?: string }) => {
      const code = (error as { code?: string } | null)?.code
      if (
        /update\s+["`]?account_transaction_lock["`]?/i.test(query.sql ?? '') &&
        (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT')
      ) {
        busyObserved = true
        observeBusy()
      }
    }
    let guard: ReturnType<typeof setTimeout> | undefined
    let secondEntered = false
    let secondPassword: string | undefined
    let second: Promise<unknown> | undefined
    let contentionObserved = false
    try {
      client = kit.db.connection().getWriteClient().client as unknown as NonNullable<typeof client>
      client.on('query-error', onQueryError)
      guard = setTimeout(
        () =>
          failBusy(
            new Error('Second SQLite transaction never hit SQLITE_BUSY at account_transaction_lock')
          ),
        5000
      )
      second = transaction(kit.db, async (trx) => {
        secondEntered = true
        await lockRow(trx, 'users', id)
        const row = await trx.from('users').where('id', id).first()
        secondPassword = row.password
      })
      void second.then(
        () => {
          if (!busyObserved)
            failBusy(
              new Error('Second SQLite transaction completed before contention was observed')
            )
        },
        (error) => {
          if (!busyObserved) failBusy(error instanceof Error ? error : new Error(String(error)))
        }
      )
      await busy
      assert.isFalse(secondEntered, 'the second callback must not enter before the writer releases')
      contentionObserved = true
    } finally {
      if (guard) clearTimeout(guard)
      client?.off('query-error', onQueryError)
      releaseFirst()
      if (!contentionObserved) await Promise.allSettled([first, ...(second ? [second] : [])])
    }

    if (!second) throw new Error('Second SQLite transaction did not start')
    await Promise.all([first, second])
    assert.equal(secondPassword, 'committed')
  }).timeout(8000)

  test('a SQLite lock does not fire application update triggers', async ({ assert }) => {
    if (locksRows) return
    const schema = kit.db.connection().schema
    await kit.db.rawQuery('DROP TRIGGER IF EXISTS test_user_update').exec()
    await schema.dropTableIfExists('test_update_audit')
    await kit.db.table('users').insert({ email: 'trigger@example.test', created_at: new Date() })
    const { id } = await kit.db.from('users').where('email', 'trigger@example.test').first()
    await schema.createTable('test_update_audit', (table) => {
      table.increments('id')
    })
    await kit.db
      .rawQuery(
        'CREATE TRIGGER test_user_update AFTER UPDATE ON users BEGIN INSERT INTO test_update_audit (id) VALUES (NULL); END'
      )
      .exec()
    try {
      await transaction(kit.db, async (trx) => {
        await lockRow(trx, 'users', id)
        assert.isNotNull(await trx.from('users').where('id', id).first())
      })
      assert.lengthOf(await kit.db.from('test_update_audit'), 0)
    } finally {
      await kit.db.rawQuery('DROP TRIGGER test_user_update').exec()
      await schema.dropTableIfExists('test_update_audit')
    }
  })

  test('locks rows in the configured users table name on SQLite', async ({ assert }) => {
    if (locksRows) return

    const schema = kit.db.connection().schema
    await schema.dropTableIfExists('auth_access_tokens')
    await schema.dropTableIfExists('account_email_changes')
    await schema.dropTableIfExists('email_verification_tokens')
    await schema.dropTableIfExists('account_invitations')
    await schema.dropTableIfExists('password_reset_tokens')
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
})
