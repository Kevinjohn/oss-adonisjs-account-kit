/** Response shaping shared by managed endpoint handlers: proof errors, policy errors, account bodies. */
import type { HttpContext } from '@adonisjs/core/http'
import { DeliveryError, InvalidTokenError, PostCommitError } from '../errors.js'
import type { CurrentAccount } from '../types.js'
import {
  applyMappedHeaders,
  managedErrorResponse,
  type ManagedMessage,
  type ManagedTranslator,
} from './responses.js'
import type { ManagedEndpointName } from './routes.js'

/** The request's `@adonisjs/i18n` instance, set by its locale middleware, when the app has one. */
export function requestTranslator(context: HttpContext): ManagedTranslator | undefined {
  return 'i18n' in context ? (context.i18n as ManagedTranslator) : undefined
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
    i18n: requestTranslator(context),
  })!
  applyMappedHeaders(context, mapped)
  return context.response.status(mapped.status).send(mapped.body)
}

/**
 * A 422 for a rule the package checks itself, worded through the keys the `@adonisjs/i18n` VineJS
 * messages provider reads: `validator.shared.messages.<rule>`, with the field name from
 * `validator.shared.fields.<field>`.
 */
export function ruleError(
  context: HttpContext,
  field: string,
  rule: string,
  fallbackMessage: string
): unknown {
  const i18n = requestTranslator(context)
  const message = i18n
    ? i18n.t(
        `validator.shared.messages.${rule}`,
        { field: i18n.t(`validator.shared.fields.${field}`, {}, field) },
        fallbackMessage
      )
    : fallbackMessage
  return context.response.status(422).send({ errors: [{ field, rule, message }] })
}

export function passwordPolicyError(
  context: HttpContext,
  field: 'password' | 'newPassword'
): unknown {
  return ruleError(context, field, 'passwordPolicy', 'Password does not meet the policy.')
}

export function publicAccount(account: CurrentAccount): Record<string, unknown> {
  return {
    id: account.id,
    email: account.email,
    unverifiedEmail: account.unverifiedEmail,
    hasPassword: account.hasPassword,
    active: account.active,
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

/**
 * Logs a failure that happened after the operation committed and returns `true`; returns `false`
 * for any other error, which the caller rethrows or maps.
 */
export function reportCommittedFailure(
  context: HttpContext,
  operation: ManagedEndpointName,
  error: unknown
): boolean {
  if (!(error instanceof DeliveryError || error instanceof PostCommitError)) return false
  recoveryDiagnostic(
    context,
    operation,
    error instanceof DeliveryError ? 'delivery_failed' : 'followup_failed'
  )
  return true
}
