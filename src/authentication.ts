import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { DateTime } from 'luxon'
import { errors } from '@adonisjs/limiter'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { lockUser, transaction, userMetadata } from './db.js'
import { normaliseEmail } from './email.js'
import { limiterKey } from './throttle.js'
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
  Trx,
  UserId,
} from './types.js'

type Dependencies = { config: ResolvedConfig; db: Database; limiter: LimiterService }

function configured(deps: Pick<Dependencies, 'config'>) {
  const auth = deps.config.authentication
  if (!auth) throw new CapabilityDisabledError('Authentication is disabled')
  return auth
}

function normalizeStamp(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const iso = typeof value === 'string' ? DateTime.fromISO(value, { zone: 'utc' }) : null
  const at =
    value instanceof Date
      ? DateTime.fromJSDate(value, { zone: 'utc' })
      : typeof value === 'number'
        ? DateTime.fromMillis(value, { zone: 'utc' })
        : iso?.isValid
          ? iso
          : DateTime.fromSQL(String(value), { zone: 'utc' })
  if (!at.isValid) throw new Error('Invalid credentials_changed_at value')
  return at.toUTC().toISO()
}

export async function revision(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId
): Promise<string | null> {
  const metadata = await userMetadata(config)
  const table = metadata.table
  const row = await trx.from(table).select('credentials_changed_at').where('id', userId).first()
  if (!row) throw new InvalidCredentialsError()
  return normalizeStamp(row.credentials_changed_at)
}

/** The account lock makes the revision advance even if two changes use the same wall-clock tick. */
export async function advanceCredentialRevision(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId
): Promise<void> {
  const metadata = await userMetadata(config)
  const table = metadata.table
  const previous = await revision(trx, config, userId)
  const next = DateTime.fromMillis(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0), {
    zone: 'utc',
  })
  const value =
    trx.dialect.name === 'better-sqlite3'
      ? next.toFormat('yyyy-MM-dd HH:mm:ss.SSS')
      : next.toFormat(trx.dialect.dateTimeFormat)
  await trx.from(table).where('id', userId).update({ credentials_changed_at: value })
  if (config.authentication?.strategy === 'access_tokens') {
    await trx.from(config.authentication.tokenTable).where('tokenable_id', userId).delete()
  }
}

export async function credentialsChanged(
  trx: Trx,
  config: ResolvedConfig,
  user: AccountUser,
  context: Parameters<NonNullable<ResolvedConfig['onCredentialsChangedTransaction']>>[1]
): Promise<void> {
  if (config.enabled.includes('socialAuthentication')) {
    await trx.from('social_sensitive_proofs').where('user_id', user.id).delete()
    await trx.from('social_transactions').where('user_id', user.id).delete()
  }
  if (config.authentication) await advanceCredentialRevision(trx, config, user.id)
  await config.onCredentialsChangedTransaction?.(user, context, trx)
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
  if (auth.strategy === 'session') {
    // Absence is different from the valid pre-first-change null stamp.
    if (
      !Object.hasOwn(input, 'revision') ||
      input.revision !== (await revision(trx, deps.config, input.userId))
    )
      throw new InvalidSessionError()
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
  return safeAccount(user)
}

export function authenticationService(deps: Dependencies) {
  return {
    /** Read-only, point-in-time inventory; run again inside the owner's maintenance window. */
    async retirementImpact(input: {
      passwordLogin: boolean
      providers?: readonly string[]
    }): Promise<{
      inspectedAccounts: number
      affectedAccounts: number
      checkedAt: string
    }> {
      configured(deps)
      if (input.passwordLogin !== false)
        throw new Error('Password-login retirement must be selected explicitly')
      if (input.providers?.length)
        throw new Error(
          'Social identity inventory is unavailable until provider integration is installed'
        )
      const { table } = await userMetadata(deps.config)
      let inspectedAccounts = 0
      let affectedAccounts = 0
      let lastId: UserId | undefined
      for (;;) {
        const query = deps.db.from(table).select('id').orderBy('id', 'asc').limit(500)
        if (lastId !== undefined) query.where('id', '>', lastId)
        const rows = await query
        if (!rows.length) break
        for (const row of rows) {
          const id = row.id as UserId
          const user = await deps.config.users.findById(id)
          if (!user) throw new Error('Account adapter could not resolve an inventoried user')
          if (typeof user.hasPassword !== 'boolean')
            throw new Error(
              'Account adapter must report whether each inventoried user has a password'
            )
          inspectedAccounts++
          if (user.hasPassword) affectedAccounts++
          lastId = id
        }
      }
      return { inspectedAccounts, affectedAccounts, checkedAt: new Date().toISOString() }
    },

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
      const key = (operation: string, value: string) =>
        limiterKey(operation, value, deps.config.limiterSecret, deps.config.limiterNamespace)
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
          let remaining = deps.config.minRequestMs - (performance.now() - started)
          while (remaining > 0) {
            await delay(Math.ceil(remaining))
            remaining = deps.config.minRequestMs - (performance.now() - started)
          }
        }
        if (error instanceof errors.E_TOO_MANY_REQUESTS)
          throw new ThrottledError(error.response.availableIn, undefined, { cause: error })
        throw error
      }

      let credential: Credential | undefined
      try {
        credential =
          guard.strategy === 'session'
            ? await guard.establish(verified.account.id, verified.revision)
            : await guard.establish(verified.account.id, auth.tokenAbilities, auth.tokenExpiresIn)
        // Adonis token issuance and session writes do not share the package transaction. A
        // post-issuance lock closes the gap before the credential is returned to the client.
        await transaction(deps.db, async (trx) => {
          await lockUser(trx, deps.config, verified.account.id)
          const user = await deps.config.users.findById(verified.account.id, trx)
          if (
            !user ||
            user.email !== email ||
            (await revision(trx, deps.config, user.id)) !== verified.revision ||
            !(await auth.canAccess(user, trx))
          )
            throw new InvalidCredentialsError()
        })
        return { account: verified.account, credential }
      } catch (error) {
        try {
          await guard.terminate(credential)
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Login failed and credential cleanup failed'
          )
        }
        throw error
      }
    },

    current(input: CurrentAccountInput): Promise<CurrentAccount> {
      return transaction(deps.db, (trx) => currentInTransaction(deps, input, trx))
    },

    async requireActive(input: CurrentAccountInput): Promise<CurrentAccount> {
      const account = await transaction(deps.db, (trx) => currentInTransaction(deps, input, trx))
      if (!account.active) throw new UnverifiedEmailError()
      return account
    },

    async logout<Credential>(
      guard: Pick<AuthenticationGuard<Credential>, 'terminate'>,
      credential?: Credential
    ): Promise<void> {
      configured(deps)
      await guard.terminate(credential)
    },

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
