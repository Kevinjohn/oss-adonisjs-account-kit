// The public identity of an Account Kit error: status, stable code, English message and the
// committed marker. Both renderers build from it, so the managed routes and the application
// helper cannot disagree.
import type { AccountKitError } from './errors.js'
import {
  AuthorizationError,
  InvalidSessionError,
  InvalidTokenError,
  InvitationManagementDeniedError,
  InvitationNotFoundError,
  PostCommitError,
  ThrottledError,
} from './errors.js'

export type ProofKind = 'password' | 'email' | 'invitation' | 'magicLink'

export interface PublicIdentity {
  status: number
  code: string
  message: string
  committed?: true
}

const OPERATION_FAILED = 'E_ACCOUNT_KIT_OPERATION_FAILED'

const invalidTokenCodes: Record<ProofKind, string> = {
  password: 'E_ACCOUNT_KIT_INVALID_PASSWORD_TOKEN',
  email: 'E_ACCOUNT_KIT_INVALID_EMAIL_TOKEN',
  invitation: 'E_ACCOUNT_KIT_INVALID_INVITATION_TOKEN',
  magicLink: 'E_ACCOUNT_KIT_INVALID_MAGIC_LINK',
}

const publicMessages: Record<string, string> = {
  E_INVALID_CREDENTIALS: 'Authentication failed.',
  E_ACCOUNT_KIT_INVITATION_NOT_FOUND: 'Invitation not found.',
  E_ACCOUNT_KIT_FORBIDDEN: 'Access denied.',
  E_ACCOUNT_KIT_INVALID_TOKEN: 'This link is invalid or expired.',
  ...Object.fromEntries(
    Object.values(invalidTokenCodes).map((code) => [code, 'This link is invalid or expired.'])
  ),
  E_ACCOUNT_KIT_UNVERIFIED_EMAIL: 'Email verification is required.',
  E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED: 'Current identity proof could not be confirmed.',
  E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED: 'The account request conflicts with an existing account.',
  E_ACCOUNT_KIT_THROTTLED: 'Too many requests.',
  [OPERATION_FAILED]: 'Account operation failed.',
}

const rejectedMessage = 'Account request rejected.'

function identity(status: number, code: string): PublicIdentity {
  return { status, code, message: publicMessages[code] ?? rejectedMessage }
}

/**
 * Maps an Account Kit error to what a client may see. Every 5xx becomes one operation-failed
 * response; the masks keep invitation and authorization details from revealing which case applies.
 */
export function publicIdentity(
  error: AccountKitError,
  options: { proof?: ProofKind } = {}
): PublicIdentity {
  if (error.status >= 500) {
    const failed = identity(500, OPERATION_FAILED)
    return error instanceof PostCommitError ? { ...failed, committed: true } : failed
  }
  if (error instanceof InvalidSessionError) return identity(401, 'E_INVALID_CREDENTIALS')
  if (error instanceof InvitationManagementDeniedError || error instanceof InvitationNotFoundError)
    return identity(404, 'E_ACCOUNT_KIT_INVITATION_NOT_FOUND')
  if (error instanceof InvalidTokenError)
    return identity(
      400,
      options.proof ? invalidTokenCodes[options.proof] : 'E_ACCOUNT_KIT_INVALID_TOKEN'
    )
  if (error instanceof AuthorizationError) return identity(403, 'E_ACCOUNT_KIT_FORBIDDEN')
  return identity(error.status, error.code)
}

/** Headers every package error response carries: no caching, and `Retry-After` when throttled. */
export function publicHeaders(error: AccountKitError): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    ...(error instanceof ThrottledError
      ? { 'Retry-After': String(Math.max(1, Math.ceil(error.retryAfterSeconds))) }
      : {}),
  }
}
