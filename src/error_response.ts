import { HttpRequest } from '@adonisjs/core/http'
import { AccountKitError } from './errors.js'
import { publicHeaders, publicIdentity, type ProofKind } from './error_identity.js'
import type { AccountKitTranslator } from './translator.js'

const JSON_API = 'application/vnd.api+json'

/** The managed routes' error response; the same shape as the public {@link AccountErrorResponse}. */
export type ManagedErrorResponse = AccountErrorResponse

/**
 * Replaces the public wording of a managed response. Receives the stable code and the default
 * message; the status and code cannot change.
 */
export type ManagedMessage = (code: string, defaultMessage: string) => string

/**
 * The error media type the `Accept` header asks for, by the framework's own negotiation: a
 * missing, wildcard or unrecognised `Accept` gets JSON. JSON:API wins on higher quality, or on
 * equal quality when it is listed before JSON.
 */
export function negotiate(accept?: string): typeof JSON_API | 'application/json' {
  const request = new HttpRequest(
    { headers: accept === undefined ? {} : { accept }, url: '/', method: 'GET' } as never,
    {} as never,
    undefined as never,
    {} as never,
    undefined as never
  )
  return request.accepts(['json', JSON_API]) === JSON_API ? JSON_API : 'application/json'
}

/** The error's own `field` name, such as `email` on a duplicate registration email. */
function ownField(error: AccountKitError): string | undefined {
  if (!Object.hasOwn(error, 'field')) return undefined
  const field = (error as { field?: unknown }).field
  return typeof field === 'string' ? field : undefined
}

/** Package errors are deliberately translated without exposing internal messages or causes. */
export function managedErrorResponse(
  error: unknown,
  options: {
    accept?: string
    proof?: ProofKind
    message?: ManagedMessage
    i18n?: AccountKitTranslator
  } = {}
): ManagedErrorResponse | null {
  if (!(error instanceof AccountKitError)) return null
  const identity = publicIdentity(error, { proof: options.proof })
  const translated =
    options.i18n?.t(`errors.${identity.code}`, {}, identity.message) ?? identity.message
  const message = options.message?.(identity.code, translated) ?? translated
  const contentType = negotiate(options.accept)
  const committed = identity.committed ? { committed: true as const } : {}
  const field = identity.code === error.code && identity.status < 500 ? ownField(error) : undefined
  return {
    status: identity.status,
    contentType,
    headers: { Vary: 'Accept', ...publicHeaders(error) },
    body: {
      errors: [
        contentType === JSON_API
          ? { code: identity.code, title: message, ...committed }
          : { code: identity.code, message, ...committed, ...(field ? { field } : {}) },
      ],
    },
  }
}

/**
 * A safe HTTP response for an Account Kit error: the status, the headers, the content type and
 * the same `{ errors: [...] }` envelope the managed routes send.
 */
export interface AccountErrorResponse {
  /** The HTTP status. */
  status: number
  /**
   * Headers to set: `Vary: Accept`, `Cache-Control` and, when throttled, `Retry-After`. Append
   * `Vary` to the response's existing value rather than replacing it.
   */
  headers: Record<string, string>
  /** `application/vnd.api+json` when the `Accept` header asks for JSON:API, otherwise JSON. */
  contentType: 'application/json' | 'application/vnd.api+json'
  /**
   * The error entries. A plain JSON entry carries `message`, plus `field` when the error names
   * one; a JSON:API entry carries `title` instead. `committed` marks a `PostCommitError`: the
   * change was saved and a later step failed. A `DeliveryError` also follows a saved change but
   * carries no marker.
   */
  body: {
    errors: Array<
      | { code: string; message: string; committed?: true; field?: string }
      | { code: string; title: string; committed?: true }
    >
  }
}

/**
 * Central application error mapping, the same mapper the managed routes use. Causes are kept for
 * private logging, never returned here. With `i18n`, the message is looked up as
 * `errors.<code>`, with the English message as the fallback. Pass the request's `Accept` header
 * as `accept` to negotiate JSON:API, and `proof` to get the per-kind code for an invalid token.
 */
export function accountErrorResponse(
  error: unknown,
  options: { i18n?: AccountKitTranslator; accept?: string; proof?: ProofKind } = {}
): AccountErrorResponse | null {
  return managedErrorResponse(error, {
    i18n: options.i18n,
    accept: options.accept,
    proof: options.proof,
  })
}
