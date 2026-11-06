import type { HttpContext } from '@adonisjs/core/http'
import { HttpRequest } from '@adonisjs/core/http'
import { AccountKitError } from '../errors.js'
import type { AccountKitTranslator } from '../translator.js'
import { publicHeaders, publicIdentity, type ProofKind } from './public_identity.js'

export { proofHeaders } from './proof_headers.js'

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

export function applyMappedHeaders(context: HttpContext, mapped: ManagedErrorResponse): void {
  for (const [name, value] of Object.entries(mapped.headers)) {
    if (name === 'Vary') context.response.vary(value)
    else context.response.header(name, value)
  }
  context.response.header('Content-Type', mapped.contentType)
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

/** Renders a package error through the request's response, for the AdonisJS exception handler. */
export async function renderAccountKitError(
  context: HttpContext,
  error: AccountKitError
): Promise<void> {
  const mapped = managedErrorResponse(error, {
    accept: context.request.header('accept'),
    i18n: 'i18n' in context ? (context.i18n as AccountKitTranslator) : undefined,
  })
  if (!mapped) return
  applyMappedHeaders(context, mapped)
  context.response.status(mapped.status).send(mapped.body)
}
