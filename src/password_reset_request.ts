import { performance } from 'node:perf_hooks'
import { sqlTimestamp } from './timestamps.ts'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { lockUser, transaction } from './db.ts'
import { finishCommitted, createLifecycleEffect, postCommit, settleCommitted } from './effects.ts'
import { normalizeEmail, isEmailShaped } from './email.ts'
import { E_ACCOUNT_KIT_INVALID_INPUT } from './errors.ts'
import { waitForFloor } from './timing.ts'
import { generateToken, hashToken } from './tokens.ts'
import { expiresAt } from './ttl.ts'
import type { AccountUser, PasswordResetRequestInput, UserId } from './types.ts'
import type { ServiceDependencies } from './service_dependencies.ts'

export async function requestPasswordReset(
  deps: ServiceDependencies,
  input: PasswordResetRequestInput
): Promise<void> {
  const started = performance.now()
  try {
    if (!isEmailShaped(input.email)) throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid email')
    if (typeof input.clientKey !== 'string' || input.clientKey.trim() === '')
      throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid client key')
    const email = normalizeEmail(input.email)

    await deps.throttler.consume('recovery:client', input.clientKey, deps.config.throttle)
    await deps.throttler.consume('recovery:email', email, deps.config.throttle)
    const user = await deps.config.users.findByEmail(email)
    if (!user) return

    const token = generateToken(deps.config.tokenSecretLength)
    const operationId = randomUUID()
    const { value: issuedUser, fault } = await settleCommitted(
      issueResetToken(deps, user.id, email, token)
    )
    if (!issuedUser) {
      if (fault) throw fault
      return
    }

    await finishCommitted(fault, 'Recovery committed but follow-ups failed', () =>
      postCommit('Recovery follow-up failed', [
        {
          kind: 'delivery',
          run: () =>
            deps.config.notify.passwordResetProvision(
              issuedUser,
              deps.config.urls.passwordReset(token)
            ),
        },
        createLifecycleEffect(deps.config, {
          type: 'password_reset.requested',
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

/**
 * Store `token` as the user's single live reset token. Locks the user, re-reads it, and issues
 * nothing (null) when the stored email no longer matches. Shared by the public request path and
 * the operator command.
 */
export function issueResetToken(
  deps: Pick<ServiceDependencies, 'config' | 'db'>,
  userId: UserId,
  email: string,
  token: string
): Promise<AccountUser | null> {
  return transaction(deps.db, async (trx) => {
    await lockUser(trx, deps.config, userId)
    const current = await deps.config.users.findById(userId, trx)
    if (!current || current.email !== email) return null
    const now = DateTime.utc()
    await trx
      .table('password_reset_tokens')
      .insert({
        tokenable_id: current.id,
        email: current.email,
        hash: hashToken(token),
        expires_at: sqlTimestamp(trx, expiresAt(now, deps.config.expiresIn.passwordReset)),
        created_at: sqlTimestamp(trx, now),
      })
      .onConflict('tokenable_id')
      .merge(['email', 'hash', 'expires_at', 'created_at'])
    await deps.config.onPasswordResetIssuedTransaction?.(current, trx)
    return current
  })
}
