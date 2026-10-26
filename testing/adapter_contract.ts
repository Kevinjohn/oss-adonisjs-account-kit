import assert from 'node:assert/strict'
import { DateTime } from 'luxon'
import type { Trx, UsersAdapter } from '../src/types.js'

/**
 * What the adapter contract suite needs to test your users adapter: the adapter, a way to run
 * transactions, and probes for stored passwords and row locks.
 */
export interface AdapterContractFixture {
  adapter: UsersAdapter
  /** Run the callback in a transaction and commit it when it returns. */
  transaction<T>(callback: (trx: Trx) => Promise<T>): Promise<T>
  /** Return the stored password value so the contract can reject plaintext persistence. */
  storedPassword(id: number | string): Promise<string | null>
  /** Check a plaintext password against the stored value, with the application's hasher. */
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
  /** Set when the adapter stores string ids; the contract then checks they round-trip as strings. */
  stringIds?: boolean
  /** Exercise updateRegistrationData: the data to send and a reader for the stored result. */
  registrationUpdate?: {
    /** The registration data to send. */
    data: Record<string, unknown>
    /** Read the stored registration data back for the given user id. */
    read(id: number | string): Promise<unknown>
    /** What `read` should return after the update. */
    expected: unknown
  }
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
      unverifiedEmail: actual.unverifiedEmail,
      hasPassword: actual.hasPassword,
      emailVerifiedAt: actual.emailVerifiedAt?.toMillis() ?? null,
    },
    {
      id: expected.id,
      email: expected.email,
      unverifiedEmail: expected.unverifiedEmail,
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
  /** Padded and upper-cased, so the adapter has to normalize it. */
  const messy = (address: string) => ` ${address.toUpperCase()} `
  /** Create attributes with the fixture's registration data, when it has any. */
  const createAttrs = (
    attributes: Omit<Parameters<UsersAdapter['create']>[0], 'registrationData'>
  ): Parameters<UsersAdapter['create']>[0] => ({
    ...attributes,
    ...(fixture.registrationData !== undefined
      ? { registrationData: fixture.registrationData }
      : {}),
  })

  const created = await fixture.transaction(async (trx) => {
    const user = await fixture.adapter.create(
      createAttrs({ email: messy(email), password, unverifiedEmail: null }),
      trx
    )
    const read = await fixture.adapter.findByEmail(email.toUpperCase(), trx)
    assertSameUser(read, user)
    await fixture.adapter.markEmailVerified(user.id, verifiedAt, trx)
    assert.equal(await fixture.adapter.verifyPassword(user.id, password, trx), true)
    assert.equal(await fixture.adapter.verifyPassword(user.id, 'incorrect-password', trx), false)
    return (await fixture.adapter.findById(user.id, trx))!
  })

  if (fixture.stringIds) assert.equal(typeof created.id, 'string', 'string ids should round-trip')
  assert.equal(created.email, email, 'created addresses should be normalized')
  assert.equal(created.hasPassword, true)
  assert.equal(created.emailVerifiedAt?.toMillis(), verifiedAt.toMillis())

  const storedPassword = await fixture.storedPassword(created.id)
  assert.ok(storedPassword, 'the model should persist a password')
  assert.notEqual(storedPassword, password, 'the model hook should hash before persistence')
  assert.equal(await fixture.verifyPassword(storedPassword, password), true)

  const byId = await fixture.adapter.findById(created.id)
  assertSameUser(byId, created)
  assertSameUser(await fixture.adapter.findByEmail(messy(email)), created)

  await assert.rejects(
    fixture.transaction((trx) =>
      fixture.adapter.create(
        createAttrs({ email: email.toUpperCase(), password, unverifiedEmail: null }),
        trx
      )
    ),
    'normalized duplicate addresses should violate the unique constraint'
  )

  const rolledBackEmail = `${prefix}-create-rollback@example.test`
  await assert.rejects(
    fixture.transaction(async (trx) => {
      await fixture.adapter.create(
        createAttrs({ email: rolledBackEmail, password, unverifiedEmail: null }),
        trx
      )
      assert.ok(await fixture.adapter.findByEmail(rolledBackEmail, trx))
      throw new Error('create rollback')
    }),
    /create rollback/
  )
  assert.equal(await fixture.adapter.findByEmail(rolledBackEmail), null, 'create must use trx')

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

  const normalizedChangedEmail = `${prefix}-committed@example.test`
  const changedEmailInput = messy(normalizedChangedEmail)
  const afterEmailChange = await fixture.transaction(async (trx) => {
    await fixture.adapter.setEmail(created.id, changedEmailInput, trx)
    const read = await fixture.adapter.findById(created.id, trx)
    assert.ok(read)
    assert.equal(read.email, normalizedChangedEmail, 'setEmail should normalize addresses')
    const newEmailLookup = await fixture.adapter.findByEmail(normalizedChangedEmail, trx)
    assert.equal(
      newEmailLookup?.id,
      created.id,
      'setEmail should update the email lookup inside the transaction'
    )
    assert.equal(
      await fixture.adapter.findByEmail(email, trx),
      null,
      'the old address should stop resolving inside the transaction'
    )
    return read
  })
  assert.equal(afterEmailChange.email, normalizedChangedEmail)
  const committedEmailChange = await fixture.adapter.findById(created.id)
  const committedEmailLookup = await fixture.adapter.findByEmail(normalizedChangedEmail)
  assertSameUser(committedEmailChange, afterEmailChange)
  assert.equal(
    committedEmailLookup?.id,
    created.id,
    'setEmail should persist the normalized address after commit'
  )
  assert.equal(await fixture.adapter.findByEmail(email), null)

  const changedVerifiedAt = afterEmailChange.emailVerifiedAt!.plus({ minutes: 1 })
  await assert.rejects(
    fixture.transaction(async (trx) => {
      await fixture.adapter.markEmailVerified(created.id, changedVerifiedAt, trx)
      const read = await fixture.adapter.findById(created.id, trx)
      assert.equal(read?.emailVerifiedAt?.toMillis(), changedVerifiedAt.toMillis())
      throw new Error('verification rollback')
    }),
    /verification rollback/
  )
  assertSameUser(await fixture.adapter.findById(created.id), afterEmailChange)

  const afterVerification = await fixture.transaction(async (trx) => {
    await fixture.adapter.markEmailVerified(created.id, changedVerifiedAt, trx)
    const read = await fixture.adapter.findById(created.id, trx)
    assert.equal(read?.emailVerifiedAt?.toMillis(), changedVerifiedAt.toMillis())
    return read
  })
  const committedVerification = await fixture.adapter.findById(created.id)
  assertSameUser(committedVerification, afterVerification)
  assert.equal(
    committedVerification?.emailVerifiedAt?.toMillis(),
    changedVerifiedAt.toMillis(),
    'markEmailVerified should persist its value after commit'
  )

  await fixture.assertLockBlocksWriter(afterVerification.id, (trx) =>
    fixture.acquireAccountLock(afterVerification.id, trx)
  )

  const nextPassword = 'contract-password-two'
  await assert.rejects(
    fixture.transaction(async (trx) => {
      await fixture.adapter.setPassword(afterVerification.id, nextPassword, trx)
      throw new Error('password rollback')
    }),
    /password rollback/
  )
  await fixture.transaction(async (trx) =>
    assert.equal(
      await fixture.adapter.verifyPassword(afterVerification.id, password, trx),
      true,
      'a rolled-back setPassword keeps the old password'
    )
  )
  await fixture.transaction((trx) =>
    fixture.adapter.setPassword(afterVerification.id, nextPassword, trx)
  )
  const updatedStoredPassword = await fixture.storedPassword(afterVerification.id)
  assert.ok(updatedStoredPassword)
  assert.notEqual(updatedStoredPassword, nextPassword)
  assert.equal(await fixture.verifyPassword(updatedStoredPassword, nextPassword), true)
  assert.equal(await fixture.verifyPassword(updatedStoredPassword, password), false)
  await fixture.transaction(async (trx) => {
    assert.equal(
      await fixture.adapter.verifyPassword(afterVerification.id, nextPassword, trx),
      true
    )
    assert.equal(await fixture.adapter.verifyPassword(afterVerification.id, password, trx), false)
  })

  const inactiveEmail = `${prefix}-inactive@example.test`
  const inactive = await fixture.transaction((trx) =>
    fixture.adapter.create(
      createAttrs({
        email: messy(inactiveEmail),
        unverifiedEmail: messy(inactiveEmail),
        password: null,
      }),
      trx
    )
  )
  assert.equal(inactive.email, inactiveEmail)
  assert.equal(inactive.unverifiedEmail, inactiveEmail)
  assert.equal(inactive.hasPassword, false)
  assert.equal(inactive.emailVerifiedAt, null)
  assert.equal(await fixture.storedPassword(inactive.id), null)
  await fixture.transaction(async (trx) =>
    assert.equal(
      await fixture.adapter.verifyPassword(inactive.id, '', trx),
      false,
      'a password-less user never verifies'
    )
  )
  assertSameUser(await fixture.adapter.findById(inactive.id), inactive)

  const pendingEmail = `${prefix}-pending@example.test`
  await assert.rejects(
    fixture.transaction(async (trx) => {
      await fixture.adapter.setUnverifiedEmail(inactive.id, messy(pendingEmail), trx)
      const pending = await fixture.adapter.findById(inactive.id, trx)
      assert.equal(pending?.unverifiedEmail, pendingEmail)
      throw new Error('pending address rollback')
    }),
    /pending address rollback/
  )
  assertSameUser(await fixture.adapter.findById(inactive.id), inactive)
  await fixture.transaction((trx) =>
    fixture.adapter.setUnverifiedEmail(inactive.id, messy(pendingEmail), trx)
  )
  const persistedPending = await fixture.adapter.findById(inactive.id)
  assert.equal(persistedPending?.unverifiedEmail, pendingEmail)
  await assert.rejects(
    fixture.transaction(async (trx) => {
      await fixture.adapter.setUnverifiedEmail(inactive.id, null, trx)
      const cleared = await fixture.adapter.findById(inactive.id, trx)
      assert.equal(cleared?.unverifiedEmail, null)
      throw new Error('pending clear rollback')
    }),
    /pending clear rollback/
  )
  const restoredPending = await fixture.adapter.findById(inactive.id)
  assert.equal(restoredPending?.unverifiedEmail, pendingEmail)
  await fixture.transaction((trx) => fixture.adapter.setUnverifiedEmail(inactive.id, null, trx))
  const persistedClear = await fixture.adapter.findById(inactive.id)
  assert.equal(persistedClear?.unverifiedEmail, null)
  await fixture.transaction((trx) =>
    fixture.adapter.setUnverifiedEmail(inactive.id, pendingEmail, trx)
  )
  await fixture.transaction((trx) =>
    fixture.adapter.markEmailVerified(inactive.id, verifiedAt, trx)
  )
  const activated = await fixture.adapter.findById(inactive.id)
  assert.equal(activated?.unverifiedEmail, null, 'markEmailVerified must clear pending email')
  assert.equal(activated?.emailVerifiedAt?.toMillis(), verifiedAt.toMillis())

  if (fixture.registrationUpdate) {
    const update = fixture.registrationUpdate
    const updateRegistrationData = fixture.adapter.updateRegistrationData?.bind(fixture.adapter)
    assert.ok(updateRegistrationData, 'registrationUpdate needs updateRegistrationData')
    const before = await update.read(created.id)
    await assert.rejects(
      fixture.transaction(async (trx) => {
        await updateRegistrationData(created.id, update.data, trx)
        throw new Error('registration rollback')
      }),
      /registration rollback/
    )
    assert.deepEqual(await update.read(created.id), before)
    await fixture.transaction((trx) => updateRegistrationData(created.id, update.data, trx))
    assert.deepEqual(await update.read(created.id), update.expected)
  }
  // `delete` is optional; it is required only for the accountDeletion capability.
  if (fixture.adapter.delete) {
    const remove = fixture.adapter.delete.bind(fixture.adapter)
    await assert.rejects(
      fixture.transaction(async (trx) => {
        await remove(inactive.id, trx)
        assert.equal(await fixture.adapter.findById(inactive.id, trx), null)
        throw new Error('delete rollback')
      }),
      /delete rollback/
    )
    assert.ok(await fixture.adapter.findById(inactive.id), 'a rolled-back delete keeps the user')
    await fixture.transaction((trx) => remove(inactive.id, trx))
    assert.equal(await fixture.adapter.findById(inactive.id), null, 'delete removes the user')
    assert.equal(await fixture.adapter.findByEmail(inactiveEmail), null)
    assertSameUser(await fixture.adapter.findById(created.id), committedVerification)
  }
}
