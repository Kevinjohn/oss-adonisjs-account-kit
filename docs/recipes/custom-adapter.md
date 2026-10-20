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

`adonisjs-account-kit/testing/adapter_contract` runs the same behavior checks the Lucid adapter
passes: creation, lookups, password hashing, email changes, verification, and row locking.
The application validates signup fields and presents field errors before calling the service; its
`registration.mapFields` callback selects and validates allowed profile data. The adapter receives
that trusted result and maps it to its model properties or physical columns. Adapter persistence
mapping errors are not the application's form-validation path; see [registration](../registration.md)
and [adapter mapping](../adapters.md#registration-data) for the shared `fullName` example.

```ts
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import hash from '@adonisjs/core/services/hash'
import { assertUsersAdapterContract } from 'adonisjs-account-kit/testing/adapter_contract'
import { users } from '#services/users_adapter'

test('users adapter meets the Account Kit contract', async () => {
  const emailPrefix = `custom-adapter-contract-${Date.now()}`
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
    emailPrefix,
  })
})
```

See [`testing/adapter_contract.ts`](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/testing/adapter_contract.ts) for what each fixture
method must do, and [`tests/lucid_adapter.spec.ts`](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/tests/lucid_adapter.spec.ts) for a
complete fixture.

## Isolate and clean up the contract database

The helper commits fixture records: it commits a created user, then uses that user for committed
updates and locking checks, and creates a separate inactive user. If the adapter implements the
optional `delete`, the helper removes only the inactive fixture at the end; the primary fixture
remains. A failure or interruption before that point can leave either fixture behind. Individual
failure cases roll back their own transaction; the helper does not wrap the suite in one rollback
transaction and does not guarantee a clean database when it returns. The locking check holds one
transaction open while an independent writer transaction attempts to update the same user row, so
a suite-wide rollback would remove the independent-connection behavior being tested.

Run this contract spec only against an isolated, disposable database with the same schema and
connection arrangement your adapter expects. The custom adapter and Account Kit's Lucid connection
must point to that database; the lock probe also needs an independent writer transaction. Never
point the fixture at a shared development or production database. Before each run, create or reset
the dedicated database and set a unique `emailPrefix` for that run. After every run, including a
failure or interruption:

1. Find all users whose email starts with that run's prefix, and inspect application tables for
   rows related to those fixture users.
2. Delete those users and related rows, or drop and recreate the disposable database.
3. Verify that no users with the prefix and no related fixture rows remain before reusing the
   database.

If the process is interrupted or crashes, normal teardown may not run; perform the same cleanup
before the next run. Reset the database before rerunning rather than relying on helper cleanup or
on a previous run's rollback cases.
