import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { errors } from '@adonisjs/limiter'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { lockUser, transaction } from './db.js'
import { normaliseEmail } from './email.js'
import { throttlerOf, type Throttler } from './throttle.js'
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
  CapabilityDisabledError,
  InvalidCredentialsError,
  InvalidSessionError,
  ThrottledError,
  UnverifiedEmailError,
} from './errors.js'
import type {
  AccountUser,
  AuthenticationGuard,
  CurrentAccount,
  CurrentAccountInput,
  PasswordLoginInput,
  ResolvedConfig,
  SocialProviderName,
  Trx,
  UserId,
} from './types.js'

export { advanceCredentialRevision, credentialsChanged, revision } from './credential_revision.js'

type Dependencies = {
  config: ResolvedConfig
  db: Database
  limiter: LimiterService
  throttler?: Throttler
}

function configured(deps: Pick<Dependencies, 'config'>) {
  const auth = deps.config.authentication
  if (!auth) throw new CapabilityDisabledError('Authentication is disabled')
  return auth
}

export function safeAccount(user: AccountUser): CurrentAccount {
  return {
    id: user.id,
    email: user.email,
    unverifiedEmail: user.unverifiedEmail,
    hasPassword: user.hasPassword,
    active: user.unverifiedEmail === null || user.unverifiedEmail !== user.email,
  }
}

export async function currentInTransaction(
  deps: Pick<Dependencies, 'config'>,
  input: CurrentAccountInput,
  trx: Trx
): Promise<CurrentAccount> {
  const auth = configured(deps)
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
  return safeAccount(user)
}

export function authenticationService(deps: Dependencies) {
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
      configured(deps)
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
      const auth = configured(deps)
      if (guard.strategy !== auth.strategy || guard.name !== auth.guard)
        throw new Error(`account_kit: expected ${auth.guard} ${auth.strategy} guard`)
      if (
        typeof input.email !== 'string' ||
        typeof input.password !== 'string' ||
        typeof input.clientKey !== 'string' ||
        input.clientKey.length === 0
      )
        throw new InvalidCredentialsError()

      const email = normaliseEmail(input.email)
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

    /** Pass `current` to also remove this session from the sign-in list. */
    async logout<Credential>(
      guard: Pick<AuthenticationGuard<Credential>, 'terminate'>,
      credential?: Credential,
      current?: CurrentAccountInput
    ): Promise<void> {
      configured(deps)
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
      configured(deps)
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
