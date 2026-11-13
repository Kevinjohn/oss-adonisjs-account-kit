import { HttpRequest } from '@adonisjs/core/http'
import { AccountKitError } from './errors.js'
import { publicHeaders, publicIdentity, type ProofKind } from './error_identity.js'
import type { AccountKitTranslator } from './translator.js'

const JSON_API = 'application/vnd.api+json'

export interface ManagedErrorResponse {
  status: number
  headers: Record<string, string>
  contentType: 'application/json' | 'application/vnd.api+json'
  body: {
    errors: Array<
      | { code: string; message: string; committed?: true }
      | { code: string; title: string; committed?: true }
    >
  }
}

/**
 * Replaces the public wording of a managed response. Receives the stable code and the default
 * message; the status and code cannot change.
 */
export type ManagedMessage = (code: string, defaultMessage: string) => string

/**
 * The framework's own negotiation: a missing, wildcard or unrecognised `Accept` gets JSON, and
 * JSON:API only when the client ranks it at least as high as JSON.
 */
/** The error media type the `Accept` header asks for: JSON:API or plain JSON. */
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
  return {
    status: identity.status,
    contentType,
    headers: { Vary: 'Accept', ...publicHeaders(error) },
    body: {
      errors: [
        contentType === JSON_API
          ? { code: identity.code, title: message, ...committed }
          : { code: identity.code, message, ...committed },
      ],
    },
  }
}

/**
 * A safe HTTP response for an Account Kit error: the status, the headers and the same
 * `{ errors: [...] }` envelope the managed routes send.
 */
export interface AccountErrorResponse {
  /** The HTTP status. */
  status: number
  /** Headers to set, such as `Cache-Control` and `Retry-After`. */
  headers: Record<string, string>
  /**
   * The error entries. `committed` marks a `PostCommitError`: the change was saved and a later
   * step failed. A `DeliveryError` also follows a saved change but carries no marker.
   */
  body: { errors: Array<{ code: string; message: string; committed?: true }> }
}

/**
 * Central application error mapping. Causes are kept for private logging, never returned here.
 * With `i18n`, the message is looked up as `errors.<code>`, with the English message as the
 * fallback.
 */
export function accountErrorResponse(
  error: unknown,
  options: { i18n?: AccountKitTranslator } = {}
): AccountErrorResponse | null {
  if (!(error instanceof AccountKitError)) return null
  const identity = publicIdentity(error)
  const message =
    options.i18n?.t(`errors.${identity.code}`, {}, identity.message) ?? identity.message
  return {
    status: identity.status,
    headers: publicHeaders(error),
    body: {
      errors: [
        {
          code: identity.code,
          message,
          ...(identity.committed ? { committed: true as const } : {}),
        },
      ],
    },
  }
}
