import type { AccountErrorResponse, ManagedMessage } from './types_error_response.ts'
import { HttpRequest } from '@adonisjs/core/http'
import { E_ACCOUNT_KIT } from './errors.ts'
import {
  buildPublicErrorHeaders,
  mapPublicErrorIdentity,
  type ProofKind,
} from './error_identity.ts'
import type { AccountKitTranslator } from './translator.ts'

const JSON_API = 'application/vnd.api+json'

/** The managed routes' error response; the same shape as the public {@link AccountErrorResponse}. */
export type ManagedErrorResponse = AccountErrorResponse

/**
 * The error media type the `Accept` header asks for, by the framework's own negotiation: a
 * missing, wildcard or unrecognised `Accept` gets JSON. JSON:API wins on higher quality, or on
 * equal quality when it is listed before JSON.
 */
export function negotiate(accept?: string): typeof JSON_API | 'application/json' {
  // The header-only public mapper has no live request. Keep this framework parser shim
  // isolated here; actual HTTP responses use their context's request instead.
  const request = new HttpRequest(
    { headers: accept === undefined ? {} : { accept }, url: '/', method: 'GET' } as never,
    {} as never,
    undefined as never,
    {} as never,
    undefined as never
  )
  return negotiateRequest(request)
}

/** Picks the error media type from a live request's `Accept` header, as {@link negotiate} does. */
export function negotiateRequest(
  request: Pick<HttpRequest, 'accepts'>
): typeof JSON_API | 'application/json' {
  return request.accepts(['json', JSON_API]) === JSON_API ? JSON_API : 'application/json'
}

/** The error's own `field` name, such as `email` on a duplicate registration email. */
function getOwnErrorField(error: InstanceType<typeof E_ACCOUNT_KIT>): string | undefined {
  if (!Object.hasOwn(error, 'field')) return undefined
  const field = (error as { field?: unknown }).field
  return typeof field === 'string' ? field : undefined
}

/** Package errors are deliberately translated without exposing internal messages or causes. */
export function mapManagedErrorResponse(
  error: unknown,
  options: {
    accept?: string
    request?: Pick<HttpRequest, 'accepts'>
    proof?: ProofKind
    message?: ManagedMessage
    i18n?: AccountKitTranslator
  } = {}
): ManagedErrorResponse | null {
  if (!(error instanceof E_ACCOUNT_KIT)) return null
  const identity = mapPublicErrorIdentity(error, { proof: options.proof })
  const translated =
    options.i18n?.t(`errors.${identity.code}`, {}, identity.message) ?? identity.message
  const message = options.message?.(identity.code, translated) ?? translated
  const contentType = options.request
    ? negotiateRequest(options.request)
    : negotiate(options.accept)
  const committed = identity.committed ? { committed: true as const } : {}
  const field =
    identity.code === error.code && identity.status < 500 ? getOwnErrorField(error) : undefined
  return {
    status: identity.status,
    contentType,
    headers: { Vary: 'Accept', ...buildPublicErrorHeaders(error) },
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
 * A safe plain JSON response for an Account Kit error. When options are omitted or `undefined`,
 * the response uses `application/json` and each mapped entry carries `message`.
 *
 * @example
 * ```ts
 * import { accountErrorResponse } from '@kevinjohn/adonisjs-account-kit'
 *
 * const mapped = accountErrorResponse(error)
 * if (mapped) {
 *   for (const [name, value] of Object.entries(mapped.headers)) {
 *     if (name === 'Vary') response.vary(value)
 *     else response.header(name, value)
 *   }
 *   response.header('Content-Type', mapped.contentType)
 *   response.status(mapped.status).send(mapped.body)
 * }
 * ```
 */
export function accountErrorResponse(
  error: unknown,
  options?: undefined
):
  | (Omit<AccountErrorResponse, 'contentType' | 'body'> & {
      contentType: 'application/json'
      body: {
        errors: Array<Extract<AccountErrorResponse['body']['errors'][number], { message: string }>>
      }
    })
  | null
/**
 * Central application error mapping, the same mapper the managed routes use. Causes are kept for
 * private logging, never returned here. With `i18n`, the message is looked up as
 * `errors.<code>`, with the English message as the fallback. Pass the request's `Accept` header
 * as `accept` to negotiate JSON:API, and `proof` to get the per-kind code for an invalid token.
 * An options object may negotiate JSON:API, whose entries carry `title` instead of `message`; narrow
 * the entry before reading either property.
 *
 * @example
 * ```ts
 * import { accountErrorResponse } from '@kevinjohn/adonisjs-account-kit'
 *
 * const mapped = accountErrorResponse(error, {
 *   accept: request.header('accept'),
 *   proof: 'password',
 * })
 * if (mapped) {
 *   for (const [name, value] of Object.entries(mapped.headers)) {
 *     if (name === 'Vary') response.vary(value)
 *     else response.header(name, value)
 *   }
 *   response.header('Content-Type', mapped.contentType)
 *   response.status(mapped.status).send(mapped.body)
 * }
 * ```
 */
export function accountErrorResponse(
  error: unknown,
  options?: { i18n?: AccountKitTranslator; accept?: string; proof?: ProofKind }
): AccountErrorResponse | null
export function accountErrorResponse(
  error: unknown,
  options: { i18n?: AccountKitTranslator; accept?: string; proof?: ProofKind } = {}
): AccountErrorResponse | null {
  return mapManagedErrorResponse(error, {
    i18n: options.i18n,
    accept: options.accept,
    proof: options.proof,
  })
}

export type { AccountErrorResponse, ManagedMessage } from './types_error_response.ts'
