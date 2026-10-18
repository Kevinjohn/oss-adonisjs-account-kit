import { randomUUID } from 'node:crypto'
import { sqlTimestamp } from './timestamps.js'
import { DateTime } from 'luxon'
import type { Database } from '@adonisjs/lucid/database'
import { transaction, isUserEmailUniqueViolation } from './db.js'
import { finishCommitted, lifecycle, postCommit, settleCommitted } from './effects.js'
import { normaliseEmail, isEmailShaped } from './email.js'
import {
  CapabilityDisabledError,
  RegistrationEmailAlreadyRegisteredError,
  InvalidInputError,
} from './errors.js'
import { isPasswordAllowed } from './password.js'
import { mapRegistrationFields } from './registration_fields.js'
import { generateToken, hashToken } from './tokens.js'
import { expiresAt } from './ttl.js'
import type { PostCommitError } from './errors.js'
import type { AccountUser, RegistrationInput, ResolvedConfig } from './types.js'

/** Create an inactive account and its activation proof in one transaction. */
export async function register(
  deps: { config: ResolvedConfig; db: Database },
  input: RegistrationInput
): Promise<AccountUser> {
  if (deps.config.registration?.availability === 'closed')
    throw new CapabilityDisabledError('Registration is closed')
  if (!isEmailShaped(input.email)) throw new InvalidInputError('Invalid email')
  const email = normaliseEmail(input.email)
  if (!isPasswordAllowed(input.password, deps.config.passwordPolicy))
    throw new InvalidInputError('Invalid password')

  const registrationData = await mapRegistrationFields(deps.config, input.registrationData)

  const token = generateToken(deps.config.tokenSecretLength)
  const operationId = randomUUID()
  let created: AccountUser
  let fault: PostCommitError | undefined
  try {
    ;({ value: created, fault } = await settleCommitted(
      transaction(deps.db, async (trx) => {
        if (await deps.config.users.findByEmail(email, trx))
          throw new RegistrationEmailAlreadyRegisteredError()
        const user = await deps.config.users.create(
          {
            email,
            unverifiedEmail: email,
            password: input.password,
            registrationData,
          },
          trx
        )
        const now = DateTime.utc()
        await trx.table('email_verification_tokens').insert({
          tokenable_id: user.id,
          email,
          current_email: email,
          purpose: 'activation',
          hash: hashToken(token),
          expires_at: sqlTimestamp(trx, expiresAt(now, deps.config.expiresIn.emailVerification)),
          created_at: sqlTimestamp(trx, now),
        })
        return user
      })
    ))
  } catch (error) {
    if (await isUserEmailUniqueViolation(error, deps.config, deps.db))
      throw new RegistrationEmailAlreadyRegisteredError()
    throw error
  }

  await finishCommitted(fault, 'Registration committed but follow-ups failed', () =>
    postCommit('Registration follow-up failed', [
      {
        kind: 'delivery',
        run: () =>
          deps.config.notify.accountActivationProvision(
            created,
            deps.config.urls.emailVerification(token)
          ),
      },
      lifecycle(deps.config, {
        type: 'registration.created',
        userId: created.id,
        operationId,
      }),
    ])
  )
  return created
}
