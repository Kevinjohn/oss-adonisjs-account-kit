# Custom users adapter

If your users do not live in a Lucid model, implement `UsersAdapter` yourself. Account Kit still
uses Lucid's database connection for its own tables and transactions, so the adapter must read and
write through the `trx` it receives.

## The interface

```ts
import type { UsersAdapter } from 'adonisjs-account-kit'

export const users: UsersAdapter = {
  async resolveMetadata() {
    return { table: 'users', primaryKey: 'id' }
  },
  async findByEmail(email, trx, options) {
    /* return AccountUser | null */
  },
  async findById(id, trx, options) {
    /* return AccountUser | null */
  },
  async create({ email, unverifiedEmail, password, registrationData }, trx) {
    /* hash and insert */
  },
  async setPassword(id, password, trx) {
    /* hash and update */
  },
  async setEmail(id, email, trx) {},
  async setUnverifiedEmail(id, email, trx) {},
  async markEmailVerified(id, at, trx) {
    /* set email_verified_at and clear unverified_email */
  },
  async verifyPassword(id, password, trx) {
    /* compare with the stored hash */
  },
}
```

`AccountUser` is `{ id, email, unverifiedEmail, hasPassword, emailVerifiedAt }`. Never return the
password hash.

## Prove it with the contract suite

`adonisjs-account-kit/testing/adapter_contract` runs the same behaviour checks the Lucid adapter
passes: creation, lookups, password hashing, email changes, verification, and row locking.

```ts
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import hash from '@adonisjs/core/services/hash'
import { assertUsersAdapterContract } from 'adonisjs-account-kit/testing/adapter_contract'
import { users } from '#services/users_adapter'

test('users adapter meets the Account Kit contract', async () => {
  await assertUsersAdapterContract({
    adapter: users,
    transaction: (callback) => db.transaction(callback),
    storedPassword: async (id) =>
      (await db.from('users').where('id', id).first())?.password ?? null,
    verifyPassword: (stored, password) => hash.verify(stored, password),
    acquireAccountLock: async (id, trx) => {
      await trx.from('users').where('id', id).forUpdate().first()
    },
    assertLockBlocksWriter: async (id, acquireLock) => {
      /* hold acquireLock in one transaction and assert a second writer waits */
    },
  })
})
```

See [`testing/adapter_contract.ts`](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/testing/adapter_contract.ts) for what each fixture
method must do, and [`tests/lucid_adapter.spec.ts`](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/tests/lucid_adapter.spec.ts) for a
complete fixture.
