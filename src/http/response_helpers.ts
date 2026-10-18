/** Response shaping shared by managed endpoint handlers: proof errors, policy errors, account bodies. */
import type { HttpContext } from '@adonisjs/core/http'
import { InvalidTokenError } from '../errors.js'
import type { AccountUser, CurrentAccount } from '../types.js'
import {
  managedErrorResponse,
  type ManagedErrorResponse,
  type ManagedMessage,
} from './responses.js'
import type { ManagedEndpointName } from './routes.js'

export function applyMappedHeaders(context: HttpContext, mapped: ManagedErrorResponse): void {
  for (const [name, value] of Object.entries(mapped.headers)) {
    if (name.toLowerCase() !== 'vary') {
      context.response.header(name, value)
      continue
    }
    const existing = context.response.getHeader('Vary')
    const terms = existing
      ? String(existing)
          .split(',')
          .map((term) => term.trim())
      : []
    if (terms.includes('*')) continue
    if (!terms.some((term) => term.toLowerCase() === 'accept')) terms.push('Accept')
    context.response.header('Vary', terms.join(', '))
  }
  context.response.header('Content-Type', mapped.contentType)
}

export function invalidProof(
  context: HttpContext,
  proof: 'password' | 'email' | 'invitation' | 'magicLink',
  message?: ManagedMessage
): unknown {
  const mapped = managedErrorResponse(new InvalidTokenError(), {
    proof,
    accept: context.request.header('accept'),
    message,
  })!
  applyMappedHeaders(context, mapped)
  return context.response.status(mapped.status).send(mapped.body)
}

export function passwordPolicyError(
  context: HttpContext,
  field: 'password' | 'newPassword'
): unknown {
  return context.response.status(422).send({
    errors: [{ field, rule: 'passwordPolicy', message: 'Password does not meet the policy.' }],
  })
}

export function safeAccount(account: CurrentAccount): Record<string, unknown> {
  return {
    id: account.id,
    email: account.email,
    unverifiedEmail: account.unverifiedEmail,
    hasPassword: account.hasPassword,
    active: account.active,
  }
}

export function currentAccount(user: AccountUser): CurrentAccount {
  return {
    id: user.id,
    email: user.email,
    unverifiedEmail: user.unverifiedEmail,
    hasPassword: user.hasPassword,
    active: user.unverifiedEmail === null || user.unverifiedEmail !== user.email,
  }
}

/** Untrusted display text for the sign-in list: the client's User-Agent. The service truncates it. */
export function signInLabel(context: HttpContext): string | undefined {
  return context.request.header('user-agent') || undefined
}

export function recoveryDiagnostic(
  context: HttpContext,
  operation: ManagedEndpointName,
  outcome:
    | 'delivery_failed'
    | 'followup_failed'
    | 'authentication_failed'
    | 'representation_failed'
    | 'session_end_failed'
): void {
  context.logger?.warn({ operation, outcome }, 'Managed account operation needs reconciliation')
}
