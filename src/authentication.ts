import { RuntimeException } from '@adonisjs/core/exceptions'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { errors } from '@adonisjs/limiter'
import { requireAccountAccessDecision } from './account_access_decision.ts'
import { inspectAccountAccess } from './account_access_inspection.ts'
import { requireAuthentication } from './authentication_config.ts'
import { buildAccountProjection } from './account_projection.ts'
import { lockUser, transaction } from './db.ts'
import { normalizeEmail } from './email.ts'
import { invalidateChangedCredentials, revision } from './credential_revision.ts'
import { establishCredential } from './credential_issuance.ts'
import {
  requireLiveSession,
  isSessionTrackingEnabled,
  sessionTable,
  touchSession,
  type LiveSession,
} from './session_tracking.ts'
import { waitForFloor } from './timing.ts'
import { hashToken } from './tokens.ts'
import { assessRetirementImpact } from './login_method_retirement.ts'
import { finishCommitted, postCommit, settleCommitted } from './effects.ts'
import {
  E_INVALID_CREDENTIALS,
  E_ACCOUNT_KIT_INVALID_SESSION,
  E_ACCOUNT_KIT_THROTTLED,
  E_ACCOUNT_KIT_UNVERIFIED_EMAIL,
} from './errors.ts'
import type {
  AccountAccessInput,
  AccountAccessSnapshot,
  AccountUser,
  AuthenticationGuard,
  CurrentAccount,
  CurrentAccountContext,
  CurrentAccountInput,
  PasswordLoginInput,
  SocialProviderName,
  Trx,
  UserId,
} from './types.ts'
import type { ServiceDependencies } from './service_dependencies.ts'

export async function requireCurrentAccountInTransaction(
  deps: Pick<ServiceDependencies, 'config'>,
  input: CurrentAccountInput,
  trx: Trx
): Promise<CurrentAccount> {
  const { account } = await requireCurrentAccountAndSession(deps, input, trx)
  return account
}

/** Requires the current account and returns the accepted registry session, when present. */
async function requireCurrentAccountAndSession(
  deps: Pick<ServiceDependencies, 'config'>,
  input: CurrentAccountInput,
  trx: Trx
): Promise<{ account: CurrentAccount; session?: LiveSession }> {
  const auth = requireAuthentication(deps.config)
  await lockUser(trx, deps.config, input.userId)
  const user = await deps.config.users.findById(input.userId, trx)
  if (!user) throw new E_ACCOUNT_KIT_INVALID_SESSION()
  let session: LiveSession | undefined
  if (auth.strategy === 'session') {
    // Absence is different from the valid pre-first-change null stamp.
    if (
      !Object.hasOwn(input, 'revision') ||
      input.revision !== (await revision(trx, deps.config, input.userId))
    )
      throw new E_ACCOUNT_KIT_INVALID_SESSION()
    if (isSessionTrackingEnabled(deps.config))
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
      throw new E_ACCOUNT_KIT_INVALID_SESSION()
  }
  if (!requireAccountAccessDecision(await auth.canAccess(user, trx)))
    throw new E_ACCOUNT_KIT_INVALID_SESSION()
  if (session) await touchSession(trx, deps.config, session)
  return { account: buildAccountProjection(user), session }
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
    throw new E_ACCOUNT_KIT_INVALID_SESSION()
}

/** Atomically take one attempt from a budget, or throw `E_ACCOUNT_KIT_THROTTLED` when none is left. */
async function reserveAttempt(
  limiter: ReturnType<ServiceDependencies['limiter']['use']>,
  key: string
): Promise<void> {
  try {
    await limiter.consume(key)
  } catch (error) {
    if (error instanceof errors.E_TOO_MANY_REQUESTS) {
      // A store that refuses still counts the attempt; give it back so only failures stay counted.
      // An in-memory block refuses without touching the store and reports nothing consumed.
      if (error.response.consumed > 0) await limiter.decrement(key)
      throw new E_ACCOUNT_KIT_THROTTLED(error.response.availableIn, { cause: error })
    }
    throw error
  }
}

export function createAuthenticationService(deps: ServiceDependencies) {
  return {
    /**
     * Read-only impact of the login methods that remain after a proposed change.
     *
     * @example
     * ```ts
     * await kit.authentication.retirementImpact({ passwordLogin: true, providers: ['github'] })
     * ```
     */
    async retirementImpact(input: {
      passwordLogin: boolean
      providers?: readonly SocialProviderName[]
      /**
       * When true, skip account enumeration if this request retains every method in the live
       * configuration. The returned counts are then zero because no accounts were inspected.
       * Intended for callers that do not need an inventory count, such as setup.
       */
      onlyWhenRetiring?: boolean
    }): Promise<{
      inspectedAccounts: number
      affectedAccounts: number
      checkedAt: string
      currentProviders: SocialProviderName[]
      currentPasswordLogin: boolean
    }> {
      const hasSocialLogin =
        deps.config.enabled.includes('socialAuthentication') &&
        Object.keys(deps.config.socialAuthentication?.providers ?? {}).length > 0
      if (!deps.config.authentication && !hasSocialLogin) return assessRetirementImpact(deps, input)
      requireAuthentication(deps.config)
      return assessRetirementImpact(deps, input)
    },

    /**
     * Looks up the account, checks its password and `canAccess`, then signs in through `guard`.
     * Unknown accounts, passwordless accounts, wrong passwords and access-decision denials throw
     * `E_INVALID_CREDENTIALS`, count against failed-login limits and wait out `minRequestMs`.
     * Malformed input also throws `E_INVALID_CREDENTIALS`, without counting or waiting.
     * Guard/configuration errors, throttling, infrastructure failures and credential-establishment
     * failures have their own outcomes.
     *
     * @example
     * ```ts
     * await kit.authentication.login({ email: 'sam@example.test', password, clientKey: request.ip() }, requestGuard)
     * ```
     *
     * @throws {AggregateError} If work and its transaction or credential cleanup both fail, or multiple cleanup steps fail.
     */
    async login<Credential>(
      input: PasswordLoginInput,
      guard: AuthenticationGuard<Credential>
    ): Promise<{ account: CurrentAccount; credential: Credential }> {
      const auth = requireAuthentication(deps.config)
      if (guard.strategy !== auth.strategy || guard.name !== auth.guard)
        throw new RuntimeException(`account_kit: expected ${auth.guard} ${auth.strategy} guard`)
      if (
        typeof input.email !== 'string' ||
        typeof input.password !== 'string' ||
        typeof input.clientKey !== 'string' ||
        input.clientKey.length === 0
      )
        throw new E_INVALID_CREDENTIALS()

      const email = normalizeEmail(input.email)
      const key = deps.throttler.deriveKey
      const clientKey = key('login:client', input.clientKey)
      const identityKey = key('login:identity', `${input.clientKey}\0${email}`)
      // The limiter normalises the options it receives in place; give it copies of the frozen budgets.
      const clientLimiter = deps.limiter.use({ ...auth.clientLimit })
      const identityLimiter = deps.limiter.use({ ...auth.identityLimit })
      // Reserve one attempt from each budget before checking the password. Consuming is atomic, so
      // parallel requests cannot all pass a read-then-increment check. Only credential failures
      // keep their reservation; success and unrelated errors give it back.
      await reserveAttempt(clientLimiter, clientKey)
      try {
        await reserveAttempt(identityLimiter, identityKey)
      } catch (error) {
        await clientLimiter.decrement(clientKey)
        throw error
      }
      let verified: { account: CurrentAccount; revision: string | null }
      const started = performance.now()
      try {
        verified = await transaction(deps.db, async (trx) => {
          const candidate = await deps.config.users.findByEmail(email, trx)
          if (!candidate?.hasPassword) throw new E_INVALID_CREDENTIALS()
          await lockUser(trx, deps.config, candidate.id)
          const user = await deps.config.users.findById(candidate.id, trx)
          if (
            !user ||
            user.email !== email ||
            !user.hasPassword ||
            !(await deps.config.users.verifyPassword(user.id, input.password, trx)) ||
            !requireAccountAccessDecision(await auth.canAccess(user, trx))
          )
            throw new E_INVALID_CREDENTIALS()
          return {
            account: buildAccountProjection(user),
            revision: await revision(trx, deps.config, user.id),
          }
        })
      } catch (error) {
        if (error instanceof E_INVALID_CREDENTIALS) {
          const identity = await identityLimiter.get(identityKey)
          if (identity && identity.consumed >= identity.limit)
            await identityLimiter.block(identityKey, auth.identityLimit.blockDuration)
          // Unknown and passwordless emails skip password hashing. Wait out the configured floor
          // so failure timing does not reveal which addresses have usable accounts.
          await waitForFloor(started, deps.config.minRequestMs)
        } else {
          await clientLimiter.decrement(clientKey)
          await identityLimiter.decrement(identityKey)
        }
        throw error
      }
      await clientLimiter.decrement(clientKey)
      await identityLimiter.delete(identityKey)

      const credential = await establishCredential(deps, auth, guard, verified, {
        label: typeof input.sessionLabel === 'string' ? input.sessionLabel : undefined,
        stillValid: async (_trx, user) => user.email === email,
        rejected: () => new E_INVALID_CREDENTIALS(),
        cleanupFailed: 'Login failed and credential cleanup failed',
      })
      return { account: verified.account, credential }
    },

    /**
     * Safe account data for the signed-in credential. Throws `E_ACCOUNT_KIT_INVALID_SESSION` if it was
     * revoked or is older than the latest credential change.
     *
     * @example
     * ```ts
     * await kit.authentication.current(current)
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    current(input: CurrentAccountInput): Promise<CurrentAccount> {
      return transaction(deps.db, (trx) => requireCurrentAccountInTransaction(deps, input, trx))
    },

    /**
     * Like `current`, and also throws `E_ACCOUNT_KIT_UNVERIFIED_EMAIL` until the address is confirmed.
     *
     * @example
     * ```ts
     * await kit.authentication.requireActive(current)
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    async requireActive(input: CurrentAccountInput): Promise<CurrentAccount> {
      const account = await transaction(deps.db, (trx) =>
        requireCurrentAccountInTransaction(deps, input, trx)
      )
      if (!account.active) throw new E_ACCOUNT_KIT_UNVERIFIED_EMAIL()
      return account
    },

    /**
     * `current`, then `run` in the same transaction under the account lock, for a write of your own
     * that must commit only if the sign-in is still valid. The sign-in row (a registry session or a
     * token) is locked too, so revocation that deletes it waits for `run`; a session without a
     * registry row has nothing to lock. `trx` is the Kit's transaction: use it for every write, keep
     * `run` database-only (SQLite may retry it), and lock your own rows inside `run`, never before
     * calling this. `signInId` is the caller's row in the sign-in table under the session strategy
     * with the registry enabled, else undefined. Throws `E_ACCOUNT_KIT_INVALID_SESSION` exactly as `current`
     * does; a throw from `run` rolls everything back and surfaces unchanged.
     *
     * @example
     * ```ts
     * await kit.authentication.withCurrent(current, async ({ account, trx }) => {
     *   await trx.from('user_preferences').where('user_id', account.id).update({ theme: 'dark' })
     * })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    withCurrent<T>(
      input: CurrentAccountInput,
      run: (context: CurrentAccountContext) => Promise<T>
    ): Promise<T> {
      return transaction(deps.db, async (trx) => {
        const { account, session } = await requireCurrentAccountAndSession(deps, input, trx)
        await lockSignIn(deps, trx, input, session)
        const userId = account.id
        return run({
          account,
          signInId: session?.id,
          trx,
          readCredentialRevision: () => revision(trx, deps.config, userId),
        })
      })
    },

    /**
     * Eligibility and credential revision of one account, read under its lock, without a credential
     * for it. Not authentication: authorise the caller first. Never call it from an Account Kit
     * callback or while your own transaction holds that account's row; it opens its own transaction
     * and waits for any in-progress change to the same account. Adapters and `canAccess` must be
     * read-only through the supplied transaction and safe to retry. Missing, restricted and (when
     * required) inactive accounts share `E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED`. A `E_ACCOUNT_KIT_POST_COMMIT` discards
     * the snapshot; retry is safe under that dependency contract.
     *
     * @example
     * ```ts
     * await kit.authentication.inspectAccountAccess({ userId, requireActive: true })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    inspectAccountAccess(input: AccountAccessInput): Promise<AccountAccessSnapshot> {
      return inspectAccountAccess(deps, input)
    },

    /**
     * Pass `current` to also remove this session from the sign-in list.
     *
     * @example
     * ```ts
     * await kit.authentication.revokeCredential(requestGuard, undefined, current)
     * ```
     */
    async revokeCredential<Credential>(
      guard: Pick<AuthenticationGuard<Credential>, 'terminate'>,
      credential?: Credential,
      current?: CurrentAccountInput
    ): Promise<void> {
      requireAuthentication(deps.config)
      if (current?.sessionHandle && isSessionTrackingEnabled(deps.config))
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
     *
     * @example
     * ```ts
     * await kit.authentication.changeRestriction({
     *   userId,
     *   async change(user, trx) {
     *     await trx.from('users').where('id', user.id).update({ restricted: true })
     *   },
     * })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    async changeRestriction(input: {
      userId: UserId
      change: (user: AccountUser, trx: Trx) => Promise<void>
    }): Promise<void> {
      requireAuthentication(deps.config)
      const operationId = randomUUID()
      const { value: changed, fault } = await settleCommitted(
        transaction(deps.db, async (trx) => {
          await lockUser(trx, deps.config, input.userId)
          const current = await deps.config.users.findById(input.userId, trx)
          if (!current) throw new E_INVALID_CREDENTIALS()
          const context = {
            operation: 'access_restriction' as const,
            operationId,
            userId: current.id,
          }
          await input.change(current, trx)
          await invalidateChangedCredentials(trx, deps.config, current, context)
          return { user: current, context }
        })
      )
      await finishCommitted(fault, 'Access restriction committed but follow-ups failed', () =>
        postCommit('Access restriction follow-up failed', [
          {
            kind: 'observer',
            run: () => deps.config.onCredentialsChanged?.(changed.user, changed.context),
          },
        ])
      )
    },
  }
}
