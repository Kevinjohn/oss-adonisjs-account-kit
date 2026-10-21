// Account access inspection: eligibility and credential revision of one account, read under its lock, with no credential for it.
import { transaction, userMetadata } from './db.js'
import { readIsoTimestamp } from './timestamps.js'
import { safeAccount, requireAuthentication } from './authentication.js'
import { isUserId } from './user_id.js'
import { AccountAccessDeniedError, InvalidInputError } from './errors.js'
import type { AccountAccessInput, AccountAccessSnapshot } from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'

/** Strict read of the witness row: a missing key or undefined value is a fault, SQL null is the initial revision. */
export function readInspectionRevision(row: Record<string, unknown> | undefined): string | null {
  if (
    !row ||
    !Object.hasOwn(row, 'credentials_changed_at') ||
    row.credentials_changed_at === undefined
  )
    throw new Error('account_kit: credentials_changed_at is missing from the inspected account row')
  return readIsoTimestamp(row.credentials_changed_at)
}

async function guardDependency<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (cause) {
    if (cause instanceof AccountAccessDeniedError)
      throw new Error('account_kit: dependency threw the inspection denial error', { cause })
    throw cause
  }
}

export async function inspectAccountAccess(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  input: AccountAccessInput
): Promise<AccountAccessSnapshot> {
  if (!input || typeof input !== 'object')
    throw new InvalidInputError('Invalid account access input')
  const userId: unknown = input.userId
  const requireActive: unknown = input.requireActive
  if (!isUserId(userId) || typeof requireActive !== 'boolean')
    throw new InvalidInputError('Invalid account access input')
  const auth = requireAuthentication(deps.config)
  return transaction(deps.db, async (trx) => {
    const { table } = await guardDependency(() => userMetadata(deps.config))
    let query = trx.from(table).select('id', 'credentials_changed_at').where('id', userId)
    if (trx.dialect.name !== 'better-sqlite3') query = query.forUpdate()
    const witness = await query.first()
    if (!witness) throw new AccountAccessDeniedError()
    const revision = readInspectionRevision(witness)
    const user = await guardDependency(() => deps.config.users.findById(userId, trx))
    if (!user) throw new AccountAccessDeniedError()
    if (!isUserId(user.id))
      throw new Error('account_kit: users adapter returned a malformed account id')
    if (String(user.id) !== String(witness.id))
      throw new Error('account_kit: users adapter returned a different account than requested')
    const allowed = await guardDependency(() => auth.canAccess(user, trx))
    if (typeof allowed !== 'boolean')
      throw new Error('account_kit: canAccess must resolve to a boolean')
    if (!allowed) throw new AccountAccessDeniedError()
    const account = safeAccount(user)
    if (requireActive && !account.active) throw new AccountAccessDeniedError()
    return { account, revision }
  })
}
