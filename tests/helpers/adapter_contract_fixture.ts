import assert from 'node:assert/strict'
import { locksRows } from './dialect.js'
import { startWithBackendId, waitForDatabaseLockWait } from './lock_coordination.js'
import { defineConfig } from '../../src/config.js'
import { lockUser, transaction } from '../../src/db.js'
import type { UsersAdapter } from '../../src/types.js'
import type { AdapterContractFixture } from '../../testing/adapter_contract.js'
import type { TestApp } from './app.js'

/** Test hashing: deterministic, and visibly different from the plaintext. */
export const fakeHash = {
  hashPassword: async (password: string) => `hashed:${password}`,
  verifyPassword: async (stored: string, password: string) => stored === `hashed:${password}`,
}

/** A contract fixture over the package transaction and user lock for the given users table. */
export function contractFixture(
  kit: TestApp,
  adapter: UsersAdapter,
  options: { table?: string } & Partial<AdapterContractFixture> = {}
): AdapterContractFixture {
  const { table = 'users', ...overrides } = options
  const packageConfig = defineConfig({
    users: adapter,
    enabled: [],
    registration: { availability: 'open' },
    urls: {},
    notify: {},
    limiterSecret: 'contract-limiter-secret-with-more-than-32-bytes',
  })
  return {
    adapter,
    transaction: (callback) => transaction(kit.db, callback),
    acquireAccountLock: (id, trx) => lockUser(trx, packageConfig, id),
    async storedPassword(id) {
      const row = await kit.db.from(table).select('password').where('id', id).first()
      return row?.password ?? null
    },
    verifyPassword: fakeHash.verifyPassword,
    async assertLockBlocksWriter(id, acquireLock) {
      let locked!: () => void
      let release!: () => void
      const lockReady = new Promise<void>((resolve) => (locked = resolve))
      const holdLock = new Promise<void>((resolve) => (release = resolve))
      const lock = startWithBackendId(kit, () =>
        transaction(kit.db, async (trx) => {
          await acquireLock(trx)
          locked()
          await holdLock
        })
      )
      const lockTransaction = lock.operation
      let writerTransaction: Promise<unknown> | undefined
      let originalEmail: unknown
      const sentinel = new Error('rollback lock probe')
      let observationFailure: unknown
      let observationFailed = false
      let settled: PromiseSettledResult<unknown>[] = []
      try {
        await Promise.race([
          lockReady,
          lockTransaction.then(() => {
            throw new Error('Lock holder completed before the writer probe started')
          }),
        ])
        const original = await kit.db.from(table).select('email').where('id', id).first()
        originalEmail = original?.email
        if (locksRows) {
          const writer = startWithBackendId(kit, () =>
            transaction(kit.db, async (trx) => {
              await trx.from(table).where('id', id).update({ email: 'lock-probe@example.test' })
              throw sentinel
            })
          )
          writerTransaction = writer.operation
          const [blockingBackendId, waitingBackendId] = await Promise.all([
            lock.backendId,
            writer.backendId,
          ])
          await waitForDatabaseLockWait(
            kit,
            { isAtLeast: (actual, expected) => assert.ok(actual >= expected) },
            waitingBackendId,
            blockingBackendId,
            table
          )
        } else {
          const client = kit.db.connection().getWriteClient().client
          const native = (await client.acquireConnection()) as {
            pragma(statement: string, options?: { simple: true }): number | string
            prepare(statement: string): { run(...values: Array<number | string>): void }
          }
          const previousTimeout = native.pragma('busy_timeout', { simple: true })
          let conflict: unknown
          try {
            native.pragma('busy_timeout = 0', { simple: true })
            try {
              native
                .prepare(`UPDATE "${table}" SET email = ? WHERE id = ?`)
                .run('lock-probe@example.test', id)
            } catch (error) {
              conflict = error
            }
          } finally {
            native.pragma(`busy_timeout = ${previousTimeout}`, { simple: true })
            await client.releaseConnection(native)
          }
          assert.equal(
            (conflict as { code?: string } | undefined)?.code,
            'SQLITE_BUSY',
            'SQLite evidence is global writer serialization, not a per-row lock'
          )
        }
      } catch (error) {
        observationFailed = true
        observationFailure = error
      } finally {
        release()
        settled = await Promise.allSettled([
          lockTransaction,
          ...(writerTransaction ? [writerTransaction] : []),
        ])
      }

      const cleanupFailures = settled
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
        .filter((error) => error !== sentinel)
      if (observationFailed) {
        const additionalFailures = cleanupFailures.filter((error) => error !== observationFailure)
        if (additionalFailures.length > 0)
          throw new AggregateError(
            [observationFailure, ...additionalFailures],
            'Lock observation failed and transaction cleanup also failed'
          )
        throw observationFailure
      }

      const lockResult = settled[0]
      if (!lockResult || lockResult.status === 'rejected')
        throw lockResult?.reason ?? new Error('Lock holder did not settle')
      if (writerTransaction) {
        const writerResult = settled[1]
        assert.equal(writerResult?.status, 'rejected', 'the writer must roll back its probe')
        await assert.rejects(writerTransaction, (error: unknown) => {
          assert.equal(error, sentinel)
          return true
        })
      }
      assert.equal(
        await kit.db
          .from(table)
          .select('email')
          .where('id', id)
          .first()
          .then((row) => row?.email),
        originalEmail
      )
    },
    ...overrides,
  }
}
