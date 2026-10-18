import assert from 'node:assert/strict'
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
      const lockTransaction = transaction(kit.db, async (trx) => {
        await acquireLock(trx)
        locked()
        await holdLock
      })
      await lockReady

      let writerSettled = false
      let writerError: unknown
      const writerTransaction = transaction(kit.db, async (trx) => {
        await trx.from(table).where('id', id).update({ email: 'lock-probe@example.test' })
        throw new Error('rollback lock probe')
      }).then(
        () => {
          writerSettled = true
        },
        (error: unknown) => {
          writerError = error
          writerSettled = true
        }
      )

      try {
        await new Promise((resolve) => setTimeout(resolve, 75))
        assert.equal(writerSettled, false, 'an independent writer must wait for the user lock')
      } finally {
        release()
      }
      await lockTransaction
      await writerTransaction
      assert.match(String(writerError), /rollback lock probe/)
    },
    ...overrides,
  }
}
