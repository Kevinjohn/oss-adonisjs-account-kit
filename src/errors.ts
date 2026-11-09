import type { HttpContext } from '@adonisjs/core/http'
import { Exception, RuntimeException } from '@adonisjs/core/exceptions'

/**
 * Base for package account-operation/request errors, with a stable `code` and HTTP `status`.
 * InvalidConfigurationError is a separate setup error. Adapter, database and application errors
 * may propagate unchanged; use `accountErrorResponse` to map a safe response.
 */
export class AccountKitError extends Exception {
  /** The stable machine-readable code, such as `E_ACCOUNT_KIT_INVALID_TOKEN`. */
  static code = 'E_ACCOUNT_KIT'
  /** The HTTP status `accountErrorResponse` uses. */
  static status = 500
  declare code: string

  /**
   * `errors.<code>` for this error's own code. Responses from `accountErrorResponse` and the
   * managed routes use the public code instead, which can differ; translate those keys.
   */
  get identifier(): string {
    return `errors.${this.code}`
  }

  constructor(message = new.target.name, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }

  /** Renders the public response when the error reaches the AdonisJS exception handler. */
  async handle(error: this, ctx: HttpContext): Promise<void> {
    const { renderAccountKitError } = await import('./http/responses.js')
    await renderAccountKitError(ctx, error)
  }
}

/** A configuration value is invalid. The field names the configuration path that needs attention. */
export class InvalidConfigurationError extends RuntimeException {
  static code = 'E_ACCOUNT_KIT_INVALID_CONFIGURATION'
  static status = 500
  constructor(
    readonly field: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, { ...options, code: new.target.code, status: new.target.status })
  }
}
/**
 * Input failed a package rule, for example a password outside the policy or a malformed email.
 * Validate requests first so users see field errors.
 */
export class InvalidInputError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_INVALID_INPUT'
  static status = 422
}
/**
 * A proof token is malformed, unknown, already used or expired. Show an invalid-or-expired link
 * message and offer a new one.
 */
export class InvalidTokenError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_INVALID_TOKEN'
  static status = 400
}
/**
 * A rate limit is spent. `retryAfterSeconds` says when the caller may retry; send it as `Retry-
 * After`.
 */
export class ThrottledError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_THROTTLED'
  static status = 429
  /** Seconds until the caller may retry. */
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number, message = 'Too many requests', options?: ErrorOptions) {
    super(message, options)
    this.retryAfterSeconds = retryAfterSeconds
  }
}
/** An `authorize` callback denied the action, or public registration is closed. */
export class AuthorizationError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_AUTHORIZATION'
  static status = 403
}
/**
 * `authorize.manageInvitation` denied a resend or revoke. Reported as not found so a caller cannot
 * tell a hidden invitation from a missing one.
 */
export class InvitationManagementDeniedError extends AuthorizationError {
  static code = 'E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED'
  static status = 404
}
/** Account inspection denied: the account is missing, restricted, or inactive when active was required. */
export class AccountAccessDeniedError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED'
  static status = 403
  constructor() {
    super('Account access denied')
  }
}
/** The invitation does not exist or is no longer pending. */
export class InvitationNotFoundError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_INVITATION_NOT_FOUND'
  static status = 404
}
/** The sign-in to revoke does not exist or belongs to another user. */
export class SessionNotFoundError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_SESSION_NOT_FOUND'
  static status = 404
}
/**
 * A password or email change had a wrong or missing current password, or a social-only account had
 * no recent proof.
 */
export class IdentityNotConfirmedError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED'
  static status = 403
}
/**
 * A password or email change was attempted on an account without a local password while social
 * sign-in is disabled. Offer password reset to set a first password.
 */
export class NoPasswordError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_NO_PASSWORD'
  static status = 403
}
/** An email change or invitation targets an address that already has an account. */
export class EmailAlreadyRegisteredError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED'
  static status = 409
}
/**
 * Registration used an address that already has an account. Has `field: 'email'` so it can be shown
 * as a field error.
 */
export class RegistrationEmailAlreadyRegisteredError extends EmailAlreadyRegisteredError {
  static status = 422
  /** The request field to attach the error to. */
  readonly field = 'email'
}
/**
 * An operator command found no account for the address. Operator paths only; public flows never
 * reveal this.
 */
export class UserNotFoundError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_USER_NOT_FOUND'
  static status = 404
  constructor() {
    super('No account uses that email address')
  }
}
/** An invitation to this address is already pending; resend it instead. */
export class InvitationPendingError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_INVITATION_PENDING'
  static status = 409
}
/**
 * Delivery effects failed after the account change committed without an observer or commit-listener
 * failure. Do not repeat the operation.
 */
export class DeliveryError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_DELIVERY'
}
/**
 * A post-commit observer or commit listener failed. Any delivery failures from the same follow-up
 * batch are included in the cause. Do not repeat a committed mutation.
 * Read-only account inspection returns no snapshot; retry is safe when its dependencies satisfy
 * the documented read-only, retry-safe contract.
 */
export class PostCommitError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_POST_COMMIT'
  /** Always true: the transaction committed; an inspection snapshot may still be discarded. */
  readonly committed = true
}
/** An operation was called for a capability that is not in `enabled`. */
export class CapabilityDisabledError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_CAPABILITY_DISABLED'
}
/**
 * Login failed. One error covers unknown email, wrong password, restricted and passwordless
 * accounts, so it reveals nothing about which.
 */
export class InvalidCredentialsError extends AccountKitError {
  static code = 'E_INVALID_CREDENTIALS'
  // Official `@adonisjs/auth` uses 400; this package documents 401.
  static status = 401
  constructor() {
    super('Invalid email or password')
  }
}
/** The session or token is missing, revoked, or older than the latest credential change. */
export class InvalidSessionError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_INVALID_SESSION'
  static status = 401
  constructor() {
    super('Invalid session')
  }
}
/** `requireActive` rejected an account that has not confirmed its email address. */
export class UnverifiedEmailError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_UNVERIFIED_EMAIL'
  static status = 403
  constructor() {
    super('Email verification is required')
  }
}
/** The social sign-in state is missing, expired or does not match. Restart the provider sign-in. */
export class SocialTransactionError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID'
  static status = 400
  constructor(options?: ErrorOptions) {
    super('Invalid social transaction', options)
  }
}
/** The provider account is already linked to a different user. */
export class SocialIdentityAlreadyLinkedError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_SOCIAL_IDENTITY_ALREADY_LINKED'
  static status = 409
  constructor() {
    super('Social identity is already linked')
  }
}
/** The provider did not return an email address. */
export class SocialEmailMissingError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_SOCIAL_EMAIL_MISSING'
  static status = 422
  constructor() {
    super('Social email is required')
  }
}
/** No account is linked to this provider identity. */
export class SocialUserNotFoundError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND'
  static status = 404
  constructor() {
    super('Social account was not found')
  }
}
/** A sensitive social action lacks a valid recent authentication proof. */
export class SocialProofError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID'
  static status = 403
  constructor() {
    super('Invalid recent authentication proof')
  }
}
/** `socialAuthentication.acceptLink` refused to link this provider account. */
export class SocialLinkRefusedError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_SOCIAL_LINK_REFUSED'
  static status = 403
  constructor() {
    super('Social link refused')
  }
}
/** Unlinking would leave the account without any way to sign in. */
export class LastLoginMethodError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_SOCIAL_LAST_LOGIN_METHOD'
  static status = 409
  constructor() {
    super('At least one login method must remain')
  }
}

// Measures the full matrix for a source change; removed with its pull request.
