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

export { proofHeaders } from './proof_headers.js'

export interface ManagedErrorResponse {
  status: number
  headers: Record<string, string>
  contentType: 'application/json' | 'application/vnd.api+json'
  body: { errors: Array<{ code: string; message: string } | { code: string; title: string }> }
}

/**
 * Replaces the public wording of a managed response. Receives the stable code and the default
 * message; the status and code cannot change.
 */
export type ManagedMessage = (code: string, defaultMessage: string) => string

/**
 * The part of an `@adonisjs/i18n` `I18n` instance the managed routes use. Error wording is looked
 * up as `errors.<code>`, with the English message as the fallback.
 */
export interface ManagedTranslator {
  t(identifier: string, data: Record<string, unknown>, fallbackMessage: string): string
}

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

type ErrorClass = abstract new (...args: never[]) => AccountKitError

/** First match wins, so a subclass must come before its parent. */
const managedErrors: ReadonlyArray<readonly [ErrorClass, number, string, string]> = [
  [
    InvalidTokenError,
    400,
    'E_ACCOUNT_KIT_INVALID_PASSWORD_TOKEN',
    'This link is invalid or expired.',
  ],
  [InvalidCredentialsError, 401, 'E_INVALID_CREDENTIALS', 'Authentication failed.'],
  [InvalidSessionError, 401, 'E_INVALID_CREDENTIALS', 'Authentication failed.'],
  [UnverifiedEmailError, 403, 'E_ACCOUNT_KIT_UNVERIFIED_EMAIL', 'Email verification is required.'],
  [
    IdentityNotConfirmedError,
    403,
    'E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED',
    'Current identity proof could not be confirmed.',
  ],
  [InvitationNotFoundError, 404, 'E_ACCOUNT_KIT_INVITATION_NOT_FOUND', 'Invitation not found.'],
  [
    InvitationManagementDeniedError,
    404,
    'E_ACCOUNT_KIT_INVITATION_NOT_FOUND',
    'Invitation not found.',
  ],
  [AuthorizationError, 403, 'E_ACCOUNT_KIT_FORBIDDEN', 'Access denied.'],
  [
    EmailAlreadyRegisteredError,
    409,
    'E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED',
    'The account request conflicts with an existing account.',
  ],
  [ThrottledError, 429, 'E_ACCOUNT_KIT_THROTTLED', 'Too many requests.'],
  [InvalidInputError, 422, 'E_ACCOUNT_KIT_INVALID_INPUT', 'Account request rejected.'],
]

const invalidTokenCodes: Record<'password' | 'email' | 'invitation' | 'magicLink', string> = {
  password: 'E_ACCOUNT_KIT_INVALID_PASSWORD_TOKEN',
  email: 'E_ACCOUNT_KIT_INVALID_EMAIL_TOKEN',
  invitation: 'E_ACCOUNT_KIT_INVALID_INVITATION_TOKEN',
  magicLink: 'E_ACCOUNT_KIT_INVALID_MAGIC_LINK',
}

/** Package errors are deliberately translated without exposing internal messages or causes. */
export function managedErrorResponse(
  error: unknown,
  options: {
    accept?: string
    proof?: 'password' | 'email' | 'invitation' | 'magicLink'
    message?: ManagedMessage
    i18n?: ManagedTranslator
  } = {}
): ManagedErrorResponse | null {
  if (error instanceof PostCommitError) return null
  if (!(error instanceof AccountKitError)) return null

  let status = 500
  let code = 'E_ACCOUNT_KIT_OPERATION_FAILED'
  let message = 'Account operation failed.'
  const mapped = managedErrors.find(([errorClass]) => error instanceof errorClass)
  if (mapped) {
    status = mapped[1]
    code = mapped[2]
    message = mapped[3]
    if (error instanceof InvalidTokenError) code = invalidTokenCodes[options.proof ?? 'password']
  } else if (error.status >= 400 && error.status < 500) {
    status = error.status
    code = error.code
    message = 'Account request rejected.'
  }

  const jsonApi = prefersJsonApi(options.accept)
  const translated = options.i18n?.t(`errors.${code}`, {}, message) ?? message
  const publicMessage = options.message?.(code, translated) ?? translated
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
