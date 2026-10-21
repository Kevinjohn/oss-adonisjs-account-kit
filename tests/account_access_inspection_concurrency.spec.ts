import { test } from '@japa/runner'
import { readIsoTimestamp } from '../src/timestamps.js'
import { useTestApp } from './helpers/app.js'
import { makeService } from './helpers/fakes.js'
import { insertUser } from './helpers/insert_user.js'
import { lockNotAvailableCode, locksRows, testEngine } from './helpers/dialect.js'

test.group('authentication.inspectAccountAccess concurrency', (group) => {
  const kit = useTestApp(group)

  async function assertUserLockIsHeld(
    assert: { equal(actual: unknown, expected: unknown): void },
    userId: number | string
  ) {
    const sqliteClient = locksRows ? null : kit.db.connection().getWriteClient()
    const native = sqliteClient
      ? ((await sqliteClient.client.acquireConnection()) as {
          pragma: (statement: string, options: { simple: true }) => number | string
          prepare: (statement: string) => { run: (id: number | string) => void }
        })
      : null

    try {
      let conflict: unknown
      try {
        if (locksRows) {
          await kit.db.transaction((trx) =>
            trx.rawQuery('SELECT id FROM users WHERE id = ? FOR UPDATE NOWAIT', [userId]).exec()
          )
        } else {
          const prior = native!.pragma('busy_timeout', { simple: true })
          try {
            native!.pragma('busy_timeout = 0', { simple: true })
            native!.prepare('UPDATE users SET id = id WHERE id = ?').run(userId)
          } finally {
            native!.pragma('busy_timeout = ' + prior, { simple: true })
          }
        }
      } catch (error) {
        conflict = error
      }
      assert.equal((conflict as { code?: string } | undefined)?.code, lockNotAvailableCode)
    } finally {
      if (native) await sqliteClient!.client.releaseConnection(native)
    }
  }

  async function waitForPostgresLockWait(assert: {
    isAtLeast(actual: number, expected: number): void
  }) {
    if (testEngine !== 'pg') return
    const deadline = Date.now() + 5_000
    let waiting = 0
    while (Date.now() < deadline) {
      const result = await kit.db
        .rawQuery('select count(*) from pg_locks where granted = false')
        .exec()
      waiting = Number(result.rows[0].count)
      if (waiting >= 1) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.isAtLeast(waiting, 1)
  }

  test('waits for a restriction writer and returns its committed after-state', async ({
    assert,
  }) => {
    const user = await insertUser(kit)
    const { account } = makeService(kit, {
      authentication: {
        strategy: 'session',
        guard: 'web',
        canAccess: async () => true,
      },
    })
    let signalLocked!: () => void
    let releaseWriter!: () => void
    const locked = new Promise<void>((resolve) => (signalLocked = resolve))
    const release = new Promise<void>((resolve) => (releaseWriter = resolve))

    const writer = account.authentication.changeRestriction({
      userId: user.id,
      change: async (_current, trx) => {
        await trx.from('users').where('id', user.id).update({ unverified_email: user.email })
        signalLocked()
        await release
      },
    })
    let settled = false
    const reader = locked.then(() => {
      const pending = account.authentication.inspectAccountAccess({
        userId: user.id,
        requireActive: false,
      })
      void pending.then(
        () => (settled = true),
        () => (settled = true)
      )
      return pending
    })

    try {
      await locked
      await assertUserLockIsHeld(assert, user.id)
      await waitForPostgresLockWait(assert)
      assert.isFalse(settled)
    } finally {
      releaseWriter()
      await Promise.all([writer.catch(() => {}), reader.catch(() => {})])
    }

    const [, snapshot] = await Promise.all([writer, reader])
    const row = await kit.db.from('users').where('id', user.id).first()
    assert.isFalse(snapshot.account.active)
    assert.equal(snapshot.account.unverifiedEmail, user.email)
    assert.isNotNull(snapshot.revision)
    assert.equal(snapshot.revision, readIsoTimestamp(row.credentials_changed_at))
  }).timeout(10_000)

  test('holds its row lock through canAccess and returns the before-state', async ({ assert }) => {
    const user = await insertUser(kit)
    const beforeRow = await kit.db.from('users').where('id', user.id).first()
    const beforeRevision = readIsoTimestamp(beforeRow.credentials_changed_at)
    const beforeAccount = {
      id: user.id,
      email: user.email,
      unverifiedEmail: user.unverifiedEmail,
      hasPassword: user.hasPassword,
      active: user.unverifiedEmail !== user.email,
    }
    let signalLocked!: () => void
    let releaseReader!: () => void
    const locked = new Promise<void>((resolve) => (signalLocked = resolve))
    const release = new Promise<void>((resolve) => (releaseReader = resolve))
    const { account } = makeService(kit, {
      authentication: {
        strategy: 'session',
        guard: 'web',
        canAccess: async () => {
          signalLocked()
          await release
          return true
        },
      },
    })

    const reader = account.authentication.inspectAccountAccess({
      userId: user.id,
      requireActive: false,
    })
    let writer: Promise<void> | undefined
    let writerSettled = false

    try {
      await locked
      await assertUserLockIsHeld(assert, user.id)
      writer = account.authentication.changeRestriction({
        userId: user.id,
        change: async () => {},
      })
      void writer.then(
        () => (writerSettled = true),
        () => (writerSettled = true)
      )
      assert.isFalse(writerSettled)
    } finally {
      releaseReader()
      await Promise.all([reader.catch(() => {}), writer?.catch(() => {})])
    }

    const snapshot = await reader
    await writer
    const afterRow = await kit.db.from('users').where('id', user.id).first()
    assert.deepEqual(snapshot.account, beforeAccount)
    assert.equal(snapshot.revision, beforeRevision)
    assert.notEqual(readIsoTimestamp(afterRow.credentials_changed_at), beforeRevision)
  }).timeout(10_000)
})
