import assert from 'node:assert/strict'
import { DateTime } from 'luxon'
import type { Trx, UsersAdapter } from '../src/types.js'

export interface AdapterContractFixture {
  adapter: UsersAdapter
  /** Run the callback in a transaction and commit it when it returns. */
  transaction<T>(callback: (trx: Trx) => Promise<T>): Promise<T>
  /** Return the stored password value so the contract can reject plaintext persistence. */
  storedPassword(id: number | string): Promise<string | null>
  verifyPassword(stored: string, password: string): Promise<boolean>
  /** Hold the package-owned user lock while an independent writer targets that physical row. */
  assertLockBlocksWriter(
    id: number | string,
    acquireLock: (trx: Trx) => Promise<unknown>
  ): Promise<void>
  /** Acquire the package-owned user lock from adapter metadata, not an adapter forUpdate option. */
  acquireAccountLock(id: number | string, trx: Trx): Promise<void>
  emailPrefix?: string
  registrationData?: unknown
}

function assertSameUser(
  actual: Awaited<ReturnType<UsersAdapter['findById']>>,
  expected: Awaited<ReturnType<UsersAdapter['findById']>>
): void {
  assert.ok(actual)
  assert.ok(expected)
  assert.deepEqual(
    {
      id: actual.id,
      email: actual.email,
      hasPassword: actual.hasPassword,
      emailVerifiedAt: actual.emailVerifiedAt?.toMillis() ?? null,
    },
    {
      id: expected.id,
      email: expected.email,
      hasPassword: expected.hasPassword,
      emailVerifiedAt: expected.emailVerifiedAt?.toMillis() ?? null,
    }
  )
}

/**
 * Reusable conformance checks for a UsersAdapter. This helper depends only on Node, Luxon,
 * and adapter types; consumers provide transaction, model-hook, and package-lock fixtures.
 */
export async function assertUsersAdapterContract(fixture: AdapterContractFixture): Promise<void> {
  const prefix =
    fixture.emailPrefix ?? `adapter-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const email = `${prefix}@example.test`
  const password = 'contract-password-one'
  const verifiedAt = DateTime.local().startOf('second')

  const created = await fixture.transaction(async (trx) => {
    const user = await fixture.adapter.create(
      {
        email: ` ${email.toUpperCase()} `,
        password,
        emailVerifiedAt: verifiedAt,
        ...(fixture.registrationData !== undefined
          ? { registrationData: fixture.registrationData }
          : {}),
      },
      trx
    )
    const read = await fixture.adapter.findByEmail(email.toUpperCase(), trx)
    assertSameUser(read, user)
    assert.equal(await fixture.adapter.verifyPassword(user.id, password, trx), true)
    assert.equal(await fixture.adapter.verifyPassword(user.id, 'incorrect-password', trx), false)
    return user
  })

  assert.equal(created.email, email, 'created addresses should be normalized')
  assert.equal(created.hasPassword, true)
  assert.equal(created.emailVerifiedAt?.toMillis(), verifiedAt.toMillis())

  const storedPassword = await fixture.storedPassword(created.id)
  assert.ok(storedPassword, 'the model should persist a password')
  assert.notEqual(storedPassword, password, 'the model hook should hash before persistence')
  assert.equal(await fixture.verifyPassword(storedPassword, password), true)

  const byId = await fixture.adapter.findById(created.id)
  assertSameUser(byId, created)
  assertSameUser(await fixture.adapter.findByEmail(` ${email.toUpperCase()} `), created)

  await assert.rejects(
    fixture.transaction((trx) =>
      fixture.adapter.create(
        {
          email: email.toUpperCase(),
          password,
          emailVerifiedAt: verifiedAt,
          ...(fixture.registrationData !== undefined
            ? { registrationData: fixture.registrationData }
            : {}),
        },
        trx
      )
    ),
    'normalized duplicate addresses should violate the unique constraint'
  )

  const changedEmail = `${prefix}-rollback@example.test`
  await assert.rejects(
    fixture.transaction(async (trx) => {
      await fixture.adapter.setEmail(created.id, changedEmail, trx)
      throw new Error('contract rollback')
    }),
    /contract rollback/
  )
  assertSameUser(await fixture.adapter.findById(created.id), created)
  assert.equal(await fixture.adapter.findByEmail(changedEmail), null)

  const changedVerifiedAt = verifiedAt.plus({ minutes: 1 })
  await assert.rejects(
    fixture.transaction(async (trx) => {
      await fixture.adapter.markEmailVerified(created.id, changedVerifiedAt, trx)
      const read = await fixture.adapter.findById(created.id, trx)
      assert.equal(read?.emailVerifiedAt?.toMillis(), changedVerifiedAt.toMillis())
      throw new Error('verification rollback')
    }),
    /verification rollback/
  )
  assertSameUser(await fixture.adapter.findById(created.id), created)

  await fixture.assertLockBlocksWriter(created.id, (trx) =>
    fixture.acquireAccountLock(created.id, trx)
  )

  const nextPassword = 'contract-password-two'
  await fixture.transaction((trx) => fixture.adapter.setPassword(created.id, nextPassword, trx))
  const updatedStoredPassword = await fixture.storedPassword(created.id)
  assert.ok(updatedStoredPassword)
  assert.notEqual(updatedStoredPassword, nextPassword)
  assert.equal(await fixture.verifyPassword(updatedStoredPassword, nextPassword), true)
  assert.equal(await fixture.verifyPassword(updatedStoredPassword, password), false)
  await fixture.transaction(async (trx) => {
    assert.equal(await fixture.adapter.verifyPassword(created.id, nextPassword, trx), true)
    assert.equal(await fixture.adapter.verifyPassword(created.id, password, trx), false)
  })
}
