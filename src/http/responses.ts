import type { HttpContext } from '@adonisjs/core/http'
import type { AccountKitResponseError } from '../error_identity.ts'
import type { AccountKitTranslator } from '../translator.ts'
import { mapManagedErrorResponse, type ManagedErrorResponse } from '../error_response.ts'

export { buildProofHeaders } from './proof_headers.ts'

export {
  mapManagedErrorResponse,
  negotiate,
  negotiateRequest,
  type ManagedErrorResponse,
  type ManagedMessage,
} from '../error_response.ts'

export function applyMappedHeaders(context: HttpContext, mapped: ManagedErrorResponse): void {
  for (const [name, value] of Object.entries(mapped.headers)) {
    if (name === 'Vary') context.response.vary(value)
    else context.response.header(name, value)
  }
  context.response.header('Content-Type', mapped.contentType)
}

/** Renders a package error through the request's response, for the AdonisJS exception handler. */
export async function renderAccountKitError(
  context: HttpContext,
  error: AccountKitResponseError
): Promise<void> {
  const mapped = mapManagedErrorResponse(error, {
    request: context.request,
    i18n: 'i18n' in context ? (context.i18n as AccountKitTranslator) : undefined,
  })
  if (!mapped) return
  applyMappedHeaders(context, mapped)
  context.response.status(mapped.status).send(mapped.body)
}
