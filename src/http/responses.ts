import {
  AccountKitError,
  AuthorizationError,
  EmailAlreadyRegisteredError,
  IdentityNotConfirmedError,
  InvalidCredentialsError,
  InvalidInputError,
  InvalidSessionError,
  InvalidTokenError,
  InvitationManagementDeniedError,
  InvitationNotFoundError,
  PostCommitError,
  ThrottledError,
  UnverifiedEmailError,
} from '../errors.js'

export interface ManagedErrorResponse {
  status: number
  headers: Record<string, string>
  body: { errors: Array<{ code: string; message: string } | { code: string; title: string }> }
}

export function proofHeaders(): Record<string, string> {
  return { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
}

/** Package errors are deliberately translated without exposing internal messages or causes. */
export function managedErrorResponse(
  error: unknown,
  options: { accept?: string; proof?: 'password' | 'email' | 'invitation' } = {}
): ManagedErrorResponse | null {
  if (error instanceof PostCommitError) return null
  if (!(error instanceof AccountKitError)) return null

  let status = 500
  let code = 'E_ACCOUNT_KIT_OPERATION_FAILED'
  let message = 'Account operation failed.'
  if (error instanceof InvalidTokenError || (options.proof && error instanceof InvalidInputError)) {
    status = 400
    code =
      options.proof === 'email'
        ? 'E_INVALID_EMAIL_TOKEN'
        : options.proof === 'invitation'
          ? 'E_INVALID_INVITATION_TOKEN'
          : 'E_INVALID_PASSWORD_TOKEN'
    message = 'This link is invalid or expired.'
  } else if (error instanceof InvalidCredentialsError || error instanceof InvalidSessionError) {
    status = 401
    code = 'E_INVALID_CREDENTIALS'
    message = 'Authentication failed.'
  } else if (error instanceof UnverifiedEmailError || error instanceof IdentityNotConfirmedError) {
    status = 403
    code = 'unverified_email'
    message = 'Email verification is required.'
  } else if (
    error instanceof InvitationNotFoundError ||
    error instanceof InvitationManagementDeniedError
  ) {
    status = 404
    code = 'E_INVITATION_NOT_FOUND'
    message = 'Invitation not found.'
  } else if (error instanceof AuthorizationError) {
    status = 403
    code = 'E_ACCOUNT_KIT_FORBIDDEN'
    message = 'Access denied.'
  } else if (error instanceof EmailAlreadyRegisteredError) {
    status = 409
    code = 'E_EMAIL_ALREADY_REGISTERED'
    message = 'The account request conflicts with an existing account.'
  } else if (error instanceof ThrottledError) {
    status = 429
    code = 'E_ACCOUNT_KIT_THROTTLED'
    message = 'Too many requests.'
  } else if (error instanceof InvalidInputError) {
    status = 400
    code = 'E_ACCOUNT_KIT_INVALID_INPUT'
    message = 'Account request rejected.'
  } else if (error.status >= 400 && error.status < 500) {
    status = error.status
    code = error.code
    message = 'Account request rejected.'
  }

  return {
    status,
    headers:
      error instanceof ThrottledError
        ? { 'Retry-After': String(Math.max(1, Math.ceil(error.retryAfterSeconds))) }
        : {},
    body: {
      errors: [
        options.accept?.includes('application/vnd.api+json')
          ? { code, title: message }
          : { code, message },
      ],
    },
  }
}
