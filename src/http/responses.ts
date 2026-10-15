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
  contentType: 'application/json' | 'application/vnd.api+json'
  body: { errors: Array<{ code: string; message: string } | { code: string; title: string }> }
}

export type ManagedMessage = (code: string, defaultMessage: string) => string

function prefersJsonApi(accept?: string): boolean {
  if (!accept) return false
  const ranges = accept.split(',').map((part) => {
    const [type, ...parameters] = part
      .trim()
      .split(';')
      .map((value) => value.trim().toLowerCase())
    const q = parameters.find((parameter) => parameter.startsWith('q='))
    const value = q === undefined ? 1 : Number(q.slice(2))
    return { type, quality: Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0 }
  })
  const quality = (type: string) => {
    for (const mediaType of [type, 'application/*', '*/*']) {
      const match = ranges.find((range) => range.type === mediaType)
      if (match) return match.quality
    }
    return 0
  }
  const jsonApi = quality('application/vnd.api+json')
  return (
    ranges.some((range) => range.type === 'application/vnd.api+json') &&
    jsonApi > 0 &&
    jsonApi >= quality('application/json')
  )
}

export function proofHeaders(): Record<string, string> {
  return { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
}

/** Package errors are deliberately translated without exposing internal messages or causes. */
export function managedErrorResponse(
  error: unknown,
  options: {
    accept?: string
    proof?: 'password' | 'email' | 'invitation'
    message?: ManagedMessage
  } = {}
): ManagedErrorResponse | null {
  if (error instanceof PostCommitError) return null
  if (!(error instanceof AccountKitError)) return null

  let status = 500
  let code = 'E_ACCOUNT_KIT_OPERATION_FAILED'
  let message = 'Account operation failed.'
  if (error instanceof InvalidTokenError) {
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
  } else if (error instanceof UnverifiedEmailError) {
    status = 403
    code = 'unverified_email'
    message = 'Email verification is required.'
  } else if (error instanceof IdentityNotConfirmedError) {
    status = 403
    code = 'E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED'
    message = 'Current identity proof could not be confirmed.'
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
    status = 422
    code = 'E_ACCOUNT_KIT_INVALID_INPUT'
    message = 'Account request rejected.'
  } else if (error.status >= 400 && error.status < 500) {
    status = error.status
    code = error.code
    message = 'Account request rejected.'
  }

  const jsonApi = prefersJsonApi(options.accept)
  const publicMessage = options.message?.(code, message) ?? message
  return {
    status,
    contentType: jsonApi ? 'application/vnd.api+json' : 'application/json',
    headers: {
      Vary: 'Accept',
      ...(error instanceof ThrottledError
        ? { 'Retry-After': String(Math.max(1, Math.ceil(error.retryAfterSeconds))) }
        : {}),
    },
    body: {
      errors: [jsonApi ? { code, title: publicMessage } : { code, message: publicMessage }],
    },
  }
}
