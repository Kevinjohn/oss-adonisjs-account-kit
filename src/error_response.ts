import {
  AccountKitError,
  InvitationManagementDeniedError,
  InvitationNotFoundError,
  PostCommitError,
  ThrottledError,
} from './errors.js'
import type { AccountKitTranslator } from './translator.js'

/**
 * A safe HTTP response for an Account Kit error: status, headers such as `Retry-After`, and a
 * generic body.
 */
export interface AccountErrorResponse {
  /** The HTTP status. */
  status: number
  /** Headers to set, such as `Retry-After`. */
  headers: Record<string, string>
  /** A generic body. `committed` is true when the change was saved before a later step failed. */
  body: { code: string; message: string; committed?: true }
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
  const managed =
    error instanceof InvitationNotFoundError || error instanceof InvitationManagementDeniedError
  const code = managed ? InvitationNotFoundError.code : error.code
  const fallbackMessage = managed
    ? 'Invitation not found'
    : error.status >= 500
      ? 'Account operation failed'
      : 'Account request rejected'
  const message = options.i18n?.t(`errors.${code}`, {}, fallbackMessage) ?? fallbackMessage
  return {
    status: managed ? 404 : error.status,
    headers:
      error instanceof ThrottledError
        ? { 'Retry-After': String(Math.max(1, Math.ceil(error.retryAfterSeconds))) }
        : {},
    body: {
      code,
      message,
      ...(error instanceof PostCommitError ? { committed: true as const } : {}),
    },
  }
}
