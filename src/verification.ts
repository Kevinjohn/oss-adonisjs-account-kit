import { randomUUID } from 'node:crypto'
import { credentialsChanged } from './authentication.js'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { DateTime } from 'luxon'
import { consumeUserToken, consumeUserTokenHash, lockUser, transaction } from './db.js'
import { deliver, finishCommitted, postCommit, settleCommitted } from './effects.js'
import { InvalidInputError, InvalidTokenError } from './errors.js'
import { isPasswordAllowed } from './password.js'
import { consume } from './throttle.js'
import { generateToken, hashToken, isTokenShaped } from './tokens.js'
import { expiresAt } from './ttl.js'
import type {
  ResolvedConfig,
  UserId,
  VerificationCompleteInput,
  VerificationInspectInput,
  VerificationSendInput,
  Trx,
} from './types.js'

export async function inspectVerification(
  deps: { config: ResolvedConfig; db: Database },
  input: VerificationInspectInput
): Promise<boolean> {
  if (!isTokenShaped(input.token)) return false
  const proof = await deps.db
    .from('email_verification_tokens')
    .select('tokenable_id', 'email', 'current_email', 'purpose')
    .where('hash', hashToken(input.token))
    .where('expires_at', '>', DateTime.utc().toISO())
    .first()
  if (!proof || proof.purpose !== 'activation') return false
  const user = await deps.config.users.findById(proof.tokenable_id)
  return (
    user !== null &&
    user.email === proof.current_email &&
    user.unverifiedEmail === user.email &&
    user.unverifiedEmail === proof.email
  )
}

/** Shared activation effects; caller must hold the account lock and have consumed email proof. */
async function activateClaim(
  trx: Trx,
  config: ResolvedConfig,
  userId: UserId,
  confirmedSocialIdentityId?: number
): Promise<void> {
  await config.users.markEmailVerified(userId, DateTime.utc(), trx)
  await trx.from('password_reset_tokens').where('tokenable_id', userId).delete()
  if (config.enabled.includes('socialAuthentication')) {
    const pending = trx.from('social_identities').where('user_id', userId).whereNull('confirmed_at')
    if (confirmedSocialIdentityId !== undefined) pending.whereNot('id', confirmedSocialIdentityId)
    await pending.delete()
    if (confirmedSocialIdentityId !== undefined)
      await trx
        .from('social_identities')
        .where('user_id', userId)
        .where('id', confirmedSocialIdentityId)
        .whereNull('confirmed_at')
        .update({ confirmed_at: DateTime.utc().toISO() })
    await trx.from('social_transactions').where('user_id', userId).delete()
  }
}

/** Consume email ownership proof under the user lock. Only a matched provider can be confirmed. */
export async function completeActivation(
  trx: Trx,
  config: ResolvedConfig,
  token: string,
  confirmedSocialIdentityId?: number
): Promise<UserId> {
  return completeActivationByHash(trx, config, hashToken(token), confirmedSocialIdentityId)
}

export async function completeActivationByHash(
  trx: Trx,
  config: ResolvedConfig,
  tokenHash: string,
  confirmedSocialIdentityId?: number
): Promise<UserId> {
  const { user } = await consumeUserTokenHash<{
    tokenable_id: UserId
    email: string
    current_email: string
    purpose: string
  }>(
    trx,
    config,
    'email_verification_tokens',
    tokenHash,
    (proof, current) =>
      proof.purpose === 'activation' &&
      current.unverifiedEmail === current.email &&
      current.unverifiedEmail === proof.email &&
      current.email === proof.current_email
  )
  await activateClaim(trx, config, user.id, confirmedSocialIdentityId)
  return user.id
}

export async function sendVerification(
  deps: { config: ResolvedConfig; db: Database; limiter: LimiterService },
  input: VerificationSendInput
): Promise<'sent' | 'already_verified'> {
  const user = await deps.config.users.findById(input.userId)
  if (!user) throw new InvalidInputError('Unknown user')
  if (user.unverifiedEmail !== user.email) return 'already_verified'
  await consume(
    deps.limiter,
    'verification:user',
    String(user.id),
    deps.config.throttle,
    deps.config.limiterSecret,
    deps.config.limiterNamespace
  )
  const recent = await deps.db
    .from('email_verification_tokens')
    .select('created_at', 'expires_at', 'purpose', 'email', 'current_email')
    .where('tokenable_id', user.id)
    .first()
  if (
    recent?.purpose === 'activation' &&
    recent.email === user.email &&
    recent.current_email === user.email &&
    DateTime.fromJSDate(new Date(recent.expires_at)).toMillis() > DateTime.utc().toMillis() &&
    DateTime.fromJSDate(new Date(recent.created_at)).toMillis() >
      DateTime.utc().minus({ minutes: 1 }).toMillis()
  )
    return 'sent'
  const token = generateToken(deps.config.tokenSecretLength)
  const { value: issuedUser, fault } = await settleCommitted(
    transaction(deps.db, async (trx) => {
      await lockUser(trx, deps.config, user.id)
      const current = await deps.config.users.findById(user.id, trx)
      if (!current || current.unverifiedEmail !== current.email) return null
      const now = DateTime.utc()
      const previous = await trx
        .from('email_verification_tokens')
        .select('created_at', 'expires_at', 'purpose', 'email', 'current_email')
        .where('tokenable_id', current.id)
        .first()
      if (
        previous?.purpose === 'activation' &&
        previous.email === current.email &&
        previous.current_email === current.email &&
        DateTime.fromJSDate(new Date(previous.expires_at)).toMillis() > now.toMillis() &&
        DateTime.fromJSDate(new Date(previous.created_at)).toMillis() >
          now.minus({ minutes: 1 }).toMillis()
      )
        return false
      await trx
        .table('email_verification_tokens')
        .insert({
          tokenable_id: current.id,
          email: current.unverifiedEmail,
          current_email: current.email,
          purpose: 'activation',
          hash: hashToken(token),
          expires_at: expiresAt(now, deps.config.expiresIn.emailVerification).toISO(),
          created_at: now.toISO(),
        })
        .onConflict('tokenable_id')
        .merge(['email', 'current_email', 'purpose', 'hash', 'expires_at', 'created_at'])
      return current
    })
  )
  if (issuedUser === false) {
    if (fault) throw fault
    return 'sent'
  }
  if (!issuedUser) {
    if (fault) throw fault
    return 'already_verified'
  }
  await finishCommitted(fault, 'Verification issued but follow-up failed', () =>
    deliver('Verification notification failed', () =>
      deps.config.notify.accountActivationProvision(
        issuedUser,
        deps.config.urls.emailVerification(token)
      )
    )
  )
  return 'sent'
}

export async function completeVerification(
  deps: { config: ResolvedConfig; db: Database },
  input: VerificationCompleteInput
): Promise<'verified'> {
  if (!isPasswordAllowed(input.password, deps.config.passwordPolicy))
    throw new InvalidInputError('Invalid password')
  if (!isTokenShaped(input.token)) throw new InvalidTokenError()
  const operationId = randomUUID()
  const { value: outcome, fault } = await settleCommitted(
    transaction(deps.db, async (trx) => {
      const { user } = await consumeUserToken<{
        tokenable_id: UserId
        email: string
        current_email: string
        purpose: string
      }>(
        trx,
        deps.config,
        'email_verification_tokens',
        input.token,
        (proof, current) =>
          proof.purpose === 'activation' &&
          current.unverifiedEmail === current.email &&
          current.unverifiedEmail === proof.email &&
          current.email === proof.current_email
      )
      await deps.config.users.setPassword(user.id, input.password!, trx)
      await activateClaim(trx, deps.config, user.id)
      const reloaded = await deps.config.users.findById(user.id, trx)
      if (!reloaded) throw new InvalidTokenError()
      await credentialsChanged(trx, deps.config, reloaded, {
        operation: 'registration_claim',
        operationId,
        userId: user.id,
      })
      return reloaded
    })
  )
  await finishCommitted(fault, 'Verification committed but follow-up failed', () =>
    postCommit('Verification follow-up failed', [
      {
        kind: 'observer',
        run: () =>
          deps.config.onCredentialsChanged?.(outcome, {
            operation: 'registration_claim',
            operationId,
            userId: outcome.id,
          }),
      },
      {
        kind: 'observer',
        run: () =>
          deps.config.onLifecycleEvent?.({
            type: 'verification.completed',
            userId: outcome.id,
            operationId,
          }),
      },
    ])
  )
  return 'verified'
}
