import { test } from '@japa/runner'
import { readIsoTimestamp } from '../src/timestamps.js'
import { useTestApp } from './helpers/app.js'
import { makeService } from './helpers/fakes.js'
import { insertUser } from './helpers/insert_user.js'
import { locksRows } from './helpers/dialect.js'
import {
  assertUserLockIsHeld,
  createBarrier,
  startWithBackendId,
  waitForDatabaseLockWait,
} from './helpers/lock_coordination.js'
import type { AccountAccessSnapshot } from '../src/types.js'

test.group('authentication.inspectAccountAccess concurrency', (group) => {
  const kit = useTestApp(group)

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
    const writerBarrier = createBarrier('Restriction writer')
    let releaseWriter!: () => void
    const release = new Promise<void>((resolve) => (releaseWriter = resolve))

    const trackedWriter = startWithBackendId(kit, () =>
      account.authentication.changeRestriction({
        userId: user.id,
        change: async (_current, trx) => {
          await trx.from('users').where('id', user.id).update({ unverified_email: user.email })
          writerBarrier.signal()
          await release
        },
      })
    )
    const writer = trackedWriter.operation
    writerBarrier.observe(writer)
    let settled = false
    let trackedReader: ReturnType<typeof startWithBackendId<AccountAccessSnapshot>> | undefined
    const reader = writerBarrier.promise.then(() => {
      trackedReader = startWithBackendId(kit, () =>
        account.authentication.inspectAccountAccess({
          userId: user.id,
          requireActive: false,
        })
      )
      void trackedReader.operation.then(
        () => (settled = true),
        () => (settled = true)
      )
      return trackedReader.operation
    })

    try {
      await writerBarrier.promise
      await assertUserLockIsHeld(kit, assert, user.id)
      if (locksRows) {
        const [readerBackendId, writerBackendId] = await Promise.all([
          trackedReader!.backendId,
          trackedWriter.backendId,
        ])
        await waitForDatabaseLockWait(kit, assert, readerBackendId, writerBackendId)
      }
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
    const readerBarrier = createBarrier('Inspection reader')
    let releaseReader!: () => void
    const release = new Promise<void>((resolve) => (releaseReader = resolve))
    const { account } = makeService(kit, {
      authentication: {
        strategy: 'session',
        guard: 'web',
        canAccess: async () => {
          readerBarrier.signal()
          await release
          return true
        },
      },
    })

    const trackedReader = startWithBackendId(kit, () =>
      account.authentication.inspectAccountAccess({
        userId: user.id,
        requireActive: false,
      })
    )
    const reader = trackedReader.operation
    readerBarrier.observe(reader)
    let writer: Promise<void> | undefined
    let trackedWriter: ReturnType<typeof startWithBackendId<void>> | undefined
    let writerSettled = false

    try {
      await readerBarrier.promise
      await assertUserLockIsHeld(kit, assert, user.id)
      trackedWriter = startWithBackendId(kit, () =>
        account.authentication.changeRestriction({
          userId: user.id,
          change: async () => {},
        })
      )
      writer = trackedWriter.operation
      void writer.then(
        () => (writerSettled = true),
        () => (writerSettled = true)
      )
      if (locksRows) {
        const [writerBackendId, readerBackendId] = await Promise.all([
          trackedWriter.backendId,
          trackedReader.backendId,
        ])
        await waitForDatabaseLockWait(kit, assert, writerBackendId, readerBackendId)
      }
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
