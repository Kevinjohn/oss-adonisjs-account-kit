import { AccountKitError } from './errors.js'
import { publicHeaders, publicIdentity } from './http/public_identity.js'
import type { AccountKitTranslator } from './translator.js'

/**
 * A safe HTTP response for an Account Kit error: the status, the headers and the same
 * `{ errors: [...] }` envelope the managed routes send.
 */
export interface AccountErrorResponse {
  /** The HTTP status. */
  status: number
  /** Headers to set, such as `Cache-Control` and `Retry-After`. */
  headers: Record<string, string>
  /** The error entries. `committed` is true when the change was saved before a later step failed. */
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
