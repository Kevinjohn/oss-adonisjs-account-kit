import { performance } from 'node:perf_hooks'
import { sqlTimestamp } from './timestamps.js'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { lockUser, transaction } from './db.js'
import { finishCommitted, lifecycle, postCommit, settleCommitted } from './effects.js'
import { normalizeEmail, isEmailShaped } from './email.js'
import { InvalidInputError } from './errors.js'
import { throttlerOf } from './throttle.js'
import { waitForFloor } from './timing.js'
import { generateToken, hashToken } from './tokens.js'
import { expiresAt } from './ttl.js'
import type { AccountUser, PasswordResetRequestInput, UserId } from './types.js'
import type { ServiceDependencies } from './service_dependencies.js'

export async function requestPasswordReset(
  deps: ServiceDependencies,
  input: PasswordResetRequestInput
): Promise<void> {
  const started = performance.now()
  try {
    if (!isEmailShaped(input.email)) throw new InvalidInputError('Invalid email')
    if (typeof input.clientKey !== 'string' || input.clientKey.trim() === '')
      throw new InvalidInputError('Invalid client key')
    const email = normalizeEmail(input.email)

    await throttlerOf(deps).consume('recovery:client', input.clientKey, deps.config.throttle)
    await throttlerOf(deps).consume('recovery:email', email, deps.config.throttle)
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
        lifecycle(deps.config, {
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
  const now = DateTime.utc()
  return transaction(deps.db, async (trx) => {
    await lockUser(trx, deps.config, userId)
    const current = await deps.config.users.findById(userId, trx)
    if (!current || current.email !== email) return null
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
