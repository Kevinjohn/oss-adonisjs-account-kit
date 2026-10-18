// Passwordless sign-in by a one-use email link bound to the client that asked for it.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { DateTime } from 'luxon'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { revision, safeAccount } from './authentication.js'
import { establishCredential } from './credential_issuance.js'
import { consumeUserToken, lockUser, transaction } from './db.js'
import { finishCommitted, lifecycle, postCommit, settleCommitted } from './effects.js'
import { isEmailShaped, normaliseEmail } from './email.js'
import { CapabilityDisabledError, InvalidInputError, InvalidTokenError } from './errors.js'
import { throttlerOf, type Throttler } from './throttle.js'
import { waitForFloor } from './timing.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import { expiresAt } from './ttl.js'
import type {
  AccountUser,
  AuthenticationGuard,
  CurrentAccount,
  MagicLinkCompleteInput,
  MagicLinkInspectInput,
  MagicLinkRequestInput,
  ResolvedConfig,
  UserId,
} from './types.js'

type Dependencies = {
  config: ResolvedConfig
  db: Database
  limiter: LimiterService
  throttler?: Throttler
}

interface LinkRow {
  tokenable_id: UserId
  email: string
  client_challenge: string
}

/** A PKCE S256 challenge: base64url SHA-256, 43 characters. */
export function isClientChallenge(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

/** A PKCE verifier: 43 to 128 unreserved characters. */
export function isClientVerifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value)
}

/** The challenge a client sends for `verifier`. */
export function clientChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function verifierMatches(verifier: string, challenge: string): boolean {
  const expected = Buffer.from(challenge)
  const actual = Buffer.from(clientChallengeFor(verifier))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** Accounts that never confirmed their address cannot sign in by link. */
function isActive(user: AccountUser): boolean {
  return user.unverifiedEmail !== user.email
}

function configured(config: ResolvedConfig) {
  if (!config.authentication) throw new CapabilityDisabledError('Authentication is disabled')
  return config.authentication
}

export async function requestMagicLink(
  deps: Dependencies,
  input: MagicLinkRequestInput
): Promise<void> {
  const started = performance.now()
  try {
    const auth = configured(deps.config)
    if (!isEmailShaped(input.email)) throw new InvalidInputError('Invalid email')
    if (typeof input.clientKey !== 'string' || input.clientKey.trim() === '')
      throw new InvalidInputError('Invalid client key')
    if (!isClientChallenge(input.clientChallenge))
      throw new InvalidInputError('Invalid client challenge')
    const email = normaliseEmail(input.email)

    await throttlerOf(deps).consume('magic:client', input.clientKey, deps.config.throttle)
    await throttlerOf(deps).consume('magic:email', email, deps.config.throttle)
    const user = await deps.config.users.findByEmail(email)
    if (!user) return

    const token = generateToken(deps.config.tokenSecretLength)
    const operationId = randomUUID()
    const now = DateTime.utc()
    const { value: issuedUser, fault } = await settleCommitted(
      transaction(deps.db, async (trx) => {
        await lockUser(trx, deps.config, user.id)
        const current = await deps.config.users.findById(user.id, trx)
        if (!current || current.email !== email || !isActive(current)) return null
        if (!(await auth.canAccess(current, trx))) return null
        await trx
          .table('login_link_tokens')
          .insert({
            tokenable_id: current.id,
            email: current.email,
            hash: hashToken(token),
            client_challenge: input.clientChallenge,
            expires_at: expiresAt(now, deps.config.expiresIn.magicLink).toISO(),
            created_at: now.toISO(),
          })
          .onConflict('tokenable_id')
          .merge(['email', 'hash', 'client_challenge', 'expires_at', 'created_at'])
        return current
      })
    )
    if (!issuedUser) {
      if (fault) throw fault
      return
    }

    await finishCommitted(fault, 'Magic link committed but follow-ups failed', () =>
      postCommit('Magic link follow-up failed', [
        {
          kind: 'delivery',
          run: () =>
            deps.config.notify.magicLinkProvision(issuedUser, deps.config.urls.magicLink(token)),
        },
        lifecycle(deps.config, {
          type: 'magic_link.requested',
          userId: issuedUser.id,
          operationId,
        }),
      ])
    )
  } finally {
    // Every exit, including a throw, waits out the configured floor.
    await waitForFloor(started, deps.config.minRequestMs)
  }
}

/** Read-only: mail scanners prefetch links, so inspection never consumes. */
export async function inspectMagicLink(
  deps: { config: ResolvedConfig; db: Database },
  input: MagicLinkInspectInput
): Promise<boolean> {
  if (!isTokenShaped(input.token)) return false
  const row = await deps.db
    .from('login_link_tokens')
    .select('tokenable_id', 'email')
    .where('hash', hashToken(input.token))
    .where('expires_at', '>', DateTime.utc().toISO())
    .first()
  if (!row) return false
  const user = await deps.config.users.findById(row.tokenable_id)
  return user !== null && user.email === row.email && isActive(user)
}

/**
 * Consume the link and sign in. Any failed check still consumes the link: a link presented with
 * the wrong verifier may have been forwarded or intercepted, so the owner requests a new one.
 */
export async function completeMagicLink<Credential>(
  deps: Dependencies,
  input: MagicLinkCompleteInput,
  guard: AuthenticationGuard<Credential>
): Promise<{ account: CurrentAccount; credential: Credential }> {
  const auth = configured(deps.config)
  if (guard.strategy !== auth.strategy || guard.name !== auth.guard)
    throw new Error(`account_kit: expected ${auth.guard} ${auth.strategy} guard`)
  if (!isTokenShaped(input.token) || !isClientVerifier(input.verifier))
    throw new InvalidTokenError()

  const verified = await transaction(deps.db, async (trx) => {
    const { row, user } = await consumeUserToken<LinkRow>(
      trx,
      deps.config,
      'login_link_tokens',
      input.token,
      (candidate, account) => candidate.email === account.email
    )
    if (
      !verifierMatches(input.verifier, row.client_challenge) ||
      !isActive(user) ||
      !(await auth.canAccess(user, trx))
    )
      return null
    return {
      account: safeAccount(user),
      revision: await revision(trx, deps.config, user.id),
      email: user.email,
    }
  })
  if (!verified) throw new InvalidTokenError()
  return establishCredential(deps, auth, guard, verified)
}
