import {
  AccountKitError,
  InvitationManagementDeniedError,
  InvitationNotFoundError,
  PostCommitError,
  ThrottledError,
} from './errors.js'

export interface AccountErrorResponse {
  status: number
  headers: Record<string, string>
  body: { code: string; message: string; committed?: true }
}

/** Central application error mapping. Causes are kept for private logging, never returned here. */
export function accountErrorResponse(error: unknown): AccountErrorResponse | null {
  if (!(error instanceof AccountKitError)) return null
  const managed =
    error instanceof InvitationNotFoundError || error instanceof InvitationManagementDeniedError
  const code = managed ? InvitationNotFoundError.code : error.code
  const message = managed
    ? 'Invitation not found'
    : error.status >= 500
      ? 'Account operation failed'
      : 'Account request rejected'
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
