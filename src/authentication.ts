import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { errors } from '@adonisjs/limiter'
import { inspectAccountAccess } from './account_access_inspection.js'
import { requireAuthentication } from './authentication_config.js'
import { safeAccount } from './account_projection.js'
import { lockUser, transaction } from './db.js'
import { normalizeEmail } from './email.js'
import { throttlerOf } from './throttle.js'
import { credentialsChanged, revision } from './credential_revision.js'
import { establishCredential } from './credential_issuance.js'
import {
  requireLiveSession,
  sessionRegistryEnabled,
  sessionTable,
  touchSession,
  type LiveSession,
} from './session_registry.js'
import { waitForFloor } from './timing.js'
import { hashToken } from './tokens.js'
import { retirementImpact } from './login_method_retirement.js'
import {
  InvalidCredentialsError,
  InvalidSessionError,
  ThrottledError,
  UnverifiedEmailError,
} from './errors.js'
import type {
  AccountAccessInput,
  AccountAccessSnapshot,
  AccountUser,
  AuthenticationGuard,
  CurrentAccount,
  CurrentAccountInput,
  PasswordLoginInput,
  SocialProviderName,
  Trx,
  UserId,
} from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'

export { advanceCredentialRevision, credentialsChanged, revision } from './credential_revision.js'
export { isActiveAccount, safeAccount } from './account_projection.js'
export { requireAuthentication } from './authentication_config.js'

export async function currentInTransaction(
  deps: Pick<ServiceDependencies, 'config'>,
  input: CurrentAccountInput,
  trx: Trx
): Promise<CurrentAccount> {
  const { account } = await currentWithSessionInTransaction(deps, input, trx)
  return account
}

/** `currentInTransaction`, also returning the registry session it accepted, if any. */
export async function currentWithSessionInTransaction(
  deps: Pick<ServiceDependencies, 'config'>,
  input: CurrentAccountInput,
  trx: Trx
): Promise<{ account: CurrentAccount; session?: LiveSession }> {
  const auth = requireAuthentication(deps.config)
  await lockUser(trx, deps.config, input.userId)
  const user = await deps.config.users.findById(input.userId, trx)
  if (!user) throw new InvalidSessionError()
  let session: LiveSession | undefined
  if (auth.strategy === 'session') {
    // Absence is different from the valid pre-first-change null stamp.
    if (
      !Object.hasOwn(input, 'revision') ||
      input.revision !== (await revision(trx, deps.config, input.userId))
    )
      throw new InvalidSessionError()
    if (sessionRegistryEnabled(deps.config))
      session = await requireLiveSession(trx, input.userId, input.sessionHandle)
  } else {
    if (
      input.tokenId === undefined ||
      !(await trx
        .from(auth.tokenTable)
        .where('id', input.tokenId)
        .where('tokenable_id', input.userId)
        .first())
    )
      throw new InvalidSessionError()
  }
  if (!(await auth.canAccess(user, trx))) throw new InvalidSessionError()
  if (session) await touchSession(trx, deps.config, session)
  return { account: safeAccount(user), session }
}

/**
 * Lock the caller's sign-in row until commit, so a logout or token deletion that skips the account
 * lock waits for the caller's transaction. A row deleted since `current` read it fails closed.
 * SQLite already serializes writers.
 */
async function lockSignIn(
  deps: Pick<ServiceDependencies, 'config'>,
  trx: Trx,
  input: CurrentAccountInput,
  session: LiveSession | undefined
): Promise<void> {
  if (trx.dialect.name === 'better-sqlite3') return
  const auth = requireAuthentication(deps.config)
  const [table, id] =
    auth.strategy === 'access_tokens'
      ? [auth.tokenTable, input.tokenId]
      : [sessionTable, session?.id]
  if (id === undefined) return
  if (!(await trx.from(table).select('id').where('id', id).forUpdate().first()))
    throw new InvalidSessionError()
}

export function authenticationService(deps: ServiceDependencies) {
  return {
    /** Read-only impact of the login methods that remain after a proposed change. */
    async retirementImpact(input: {
      passwordLogin: boolean
      providers?: readonly SocialProviderName[]
    }): Promise<{
      inspectedAccounts: number
      affectedAccounts: number
      checkedAt: string
      currentProviders: SocialProviderName[]
      currentPasswordLogin: boolean
    }> {
      requireAuthentication(deps.config)
      return retirementImpact(deps, input)
    },

    /**
     * Checks the password and `canAccess`, then signs the user in through `guard`. Every failure is
     * `InvalidCredentialsError` after `minRequestMs`, and counts against the failed-login limits.
     */
    async login<Credential>(
      input: PasswordLoginInput,
      guard: AuthenticationGuard<Credential>
    ): Promise<{ account: CurrentAccount; credential: Credential }> {
      const auth = requireAuthentication(deps.config)
      if (guard.strategy !== auth.strategy || guard.name !== auth.guard)
        throw new Error(`account_kit: expected ${auth.guard} ${auth.strategy} guard`)
      if (
        typeof input.email !== 'string' ||
        typeof input.password !== 'string' ||
        typeof input.clientKey !== 'string' ||
        input.clientKey.length === 0
      )
        throw new InvalidCredentialsError()

      const email = normalizeEmail(input.email)
      const key = throttlerOf(deps).key
      const clientKey = key('login:client', input.clientKey)
      const identityKey = key('login:identity', `${input.clientKey}\0${email}`)
      const clientLimiter = deps.limiter.use(auth.clientLimit)
      const identityLimiter = deps.limiter.use(auth.identityLimit)
      const clientState = await clientLimiter.get(clientKey)
      if (clientState && clientState.remaining <= 0)
        throw new ThrottledError(clientState.availableIn)
      let verified: { account: CurrentAccount; revision: string | null }
      const started = performance.now()
      try {
        const [limitError, result] = await identityLimiter.penalize(identityKey, () =>
          transaction(deps.db, async (trx) => {
            const candidate = await deps.config.users.findByEmail(email, trx)
            if (!candidate?.hasPassword) throw new InvalidCredentialsError()
            await lockUser(trx, deps.config, candidate.id)
            const user = await deps.config.users.findById(candidate.id, trx)
            if (
              !user ||
              user.email !== email ||
              !user.hasPassword ||
              !(await deps.config.users.verifyPassword(user.id, input.password, trx)) ||
              !(await auth.canAccess(user, trx))
            )
              throw new InvalidCredentialsError()
            return {
              account: safeAccount(user),
              revision: await revision(trx, deps.config, user.id),
            }
          })
        )
        if (limitError) throw limitError
        verified = result!
      } catch (error) {
        if (error instanceof InvalidCredentialsError) {
          await clientLimiter.increment(clientKey)
          // Unknown and passwordless emails skip password hashing. Wait out the configured floor
          // so failure timing does not reveal which addresses have usable accounts.
          await waitForFloor(started, deps.config.minRequestMs)
        }
        if (error instanceof errors.E_TOO_MANY_REQUESTS)
          throw new ThrottledError(error.response.availableIn, undefined, { cause: error })
        throw error
      }

      const credential = await establishCredential(deps, auth, guard, verified, {
        label: typeof input.sessionLabel === 'string' ? input.sessionLabel : undefined,
        stillValid: async (_trx, user) => user.email === email,
        rejected: () => new InvalidCredentialsError(),
        cleanupFailed: 'Login failed and credential cleanup failed',
      })
      return { account: verified.account, credential }
    },

    /**
     * Safe account data for the signed-in credential. Throws `InvalidSessionError` if it was
     * revoked or is older than the latest credential change.
     */
    current(input: CurrentAccountInput): Promise<CurrentAccount> {
      return transaction(deps.db, (trx) => currentInTransaction(deps, input, trx))
    },

    /** Like `current`, and also throws `UnverifiedEmailError` until the address is confirmed. */
    async requireActive(input: CurrentAccountInput): Promise<CurrentAccount> {
      const account = await transaction(deps.db, (trx) => currentInTransaction(deps, input, trx))
      if (!account.active) throw new UnverifiedEmailError()
      return account
    },

    /**
     * `current`, then `run` in the same transaction under the account lock and the sign-in row's
     * lock, for a write of your own that must commit only if the sign-in is still valid. `trx` is the Kit's transaction: use it for
     * every write, keep `run` database-only (SQLite may retry it), and lock your own rows inside
     * `run`, never before calling this. `signInId` is the caller's row in the sign-in table under
     * the session strategy with the registry enabled, else undefined. Throws `InvalidSessionError`
     * exactly as `current` does; a throw from `run` rolls everything back and surfaces unchanged.
     */
    withCurrent<T>(
      input: CurrentAccountInput,
      run: (context: { account: CurrentAccount; signInId?: number; trx: Trx }) => Promise<T>
    ): Promise<T> {
      return transaction(deps.db, async (trx) => {
        const { account, session } = await currentWithSessionInTransaction(deps, input, trx)
        await lockSignIn(deps, trx, input, session)
        return run({ account, signInId: session?.id, trx })
      })
    },

    /**
     * Eligibility and credential revision of one account, read under its lock, without a credential
     * for it. Not authentication: authorise the caller first. Never call it from an Account Kit
     * callback or while your own transaction holds that account's row; it opens its own transaction
     * and waits for any in-progress change to the same account. Adapters and `canAccess` must be
     * read-only through the supplied transaction and safe to retry. Missing, restricted and (when
     * required) inactive accounts share `AccountAccessDeniedError`. A `PostCommitError` discards
     * the snapshot; retry is safe under that dependency contract.
     */
    inspectAccountAccess(input: AccountAccessInput): Promise<AccountAccessSnapshot> {
      return inspectAccountAccess(deps, input)
    },

    /** Pass `current` to also remove this session from the sign-in list. */
    async logout<Credential>(
      guard: Pick<AuthenticationGuard<Credential>, 'terminate'>,
      credential?: Credential,
      current?: CurrentAccountInput
    ): Promise<void> {
      requireAuthentication(deps.config)
      if (current?.sessionHandle && sessionRegistryEnabled(deps.config))
        await deps.db
          .from(sessionTable)
          .where('handle_hash', hashToken(current.sessionHandle))
          .where('user_id', current.userId)
          .delete()
      await guard.terminate(credential)
    },

    /**
     * Runs `change` to update your restriction state under the account lock, then ends the user's
     * sessions and tokens in the same transaction.
     */
    async changeRestriction(input: {
      userId: UserId
      change: (user: AccountUser, trx: Trx) => Promise<void>
    }): Promise<void> {
      requireAuthentication(deps.config)
      await transaction(deps.db, async (trx) => {
        await lockUser(trx, deps.config, input.userId)
        const user = await deps.config.users.findById(input.userId, trx)
        if (!user) throw new InvalidCredentialsError()
        await input.change(user, trx)
        await credentialsChanged(trx, deps.config, user, {
          operation: 'access_restriction',
          operationId: randomUUID(),
          userId: user.id,
        })
      })
    },
  }
}
