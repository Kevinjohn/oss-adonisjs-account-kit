import type { HttpContext } from '@adonisjs/core/http'
import type { E_ACCOUNT_KIT } from '../errors.js'
import type { AccountKitTranslator } from '../translator.js'
import { mapManagedErrorResponse, type ManagedErrorResponse } from '../error_response.js'

export { buildProofHeaders } from './proof_headers.js'

export {
  mapManagedErrorResponse,
  negotiate,
  negotiateRequest,
  type ManagedErrorResponse,
  type ManagedMessage,
} from '../error_response.js'

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
  error: InstanceType<typeof E_ACCOUNT_KIT>
): Promise<void> {
  const mapped = mapManagedErrorResponse(error, {
    request: context.request,
    i18n: 'i18n' in context ? (context.i18n as AccountKitTranslator) : undefined,
  })
  if (!mapped) return
  applyMappedHeaders(context, mapped)
  context.response.status(mapped.status).send(mapped.body)
}
