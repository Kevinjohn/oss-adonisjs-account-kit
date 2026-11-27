import type { HttpContext } from '@adonisjs/core/http'
import { Exception, RuntimeException } from '@adonisjs/core/exceptions'
import type { AdmissionDecision } from './admission_decision.ts'

/**
 * Base for package account-operation/request errors, with a stable `code` and HTTP `status`.
 * Configuration errors use `E_ACCOUNT_KIT_INVALID_CONFIGURATION`. Adapter, database and application
 * errors may propagate unchanged. Use `accountErrorResponse` to map a safe response.
 */
class AccountKitException extends Exception {
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

  constructor(message?: string, options?: ErrorOptions) {
    super(message ?? new.target.message ?? new.target.name, options)
    this.name = new.target.name
  }

  /** Renders the public response when the error reaches the AdonisJS exception handler. */
  async handle(error: this, ctx: HttpContext): Promise<void> {
    const { renderAccountKitError } = await import('./http/responses.js')
    await renderAccountKitError(ctx, error)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT = AccountKitException

/** A configuration value is invalid. The field names the configuration path that needs attention. */
class InvalidConfigurationException extends RuntimeException {
  static code = 'E_ACCOUNT_KIT_INVALID_CONFIGURATION'
  static status = 500
  constructor(
    readonly field: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options && 'cause' in options ? { cause: options.cause } : undefined)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INVALID_CONFIGURATION = InvalidConfigurationException

/**
 * The application's token guard returned no token, token identifier or bearer value to a managed
 * route. Clients get the generic `E_ACCOUNT_KIT_OPERATION_FAILED` 500 from the managed routes,
 * `accountErrorResponse` and `E_ACCOUNT_KIT.handle`. Managed routes log the error with the route
 * name through the request logger; on the application's own routes the AdonisJS exception handler
 * reports it, and a caller of `accountErrorResponse` logs it itself.
 */
class AdapterContractException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_ADAPTER_CONTRACT'
  static status = 500
}

/** @reexport */
export const E_ACCOUNT_KIT_ADAPTER_CONTRACT = AdapterContractException

/** The application's access callback returned a value other than a boolean. */
class InvalidAccountAccessDecisionException extends RuntimeException {
  static code = 'E_ACCOUNT_KIT_INVALID_ACCESS_DECISION'
  static status = 500
  static message = 'account_kit: canAccess must resolve to a boolean'
  declare code: string

  /** The raw error's translation key. */
  get identifier(): string {
    return `errors.${this.code}`
  }

  constructor(options?: ErrorOptions) {
    super(InvalidAccountAccessDecisionException.message, options)
  }

  /** Keeps developer callback details out of the public response. */
  async handle(error: this, ctx: HttpContext): Promise<void> {
    const { renderAccountKitError } = await import('./http/responses.js')
    await renderAccountKitError(ctx, error)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INVALID_ACCESS_DECISION = InvalidAccountAccessDecisionException

/**
 * Input failed a package rule, for example a password outside the policy or a malformed email.
 * Validate requests first so users see field errors.
 */
class InvalidInputException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_INVALID_INPUT'
  static status = 422
}

/** @reexport */
export const E_ACCOUNT_KIT_INVALID_INPUT = InvalidInputException

/**
 * A proof token is malformed, unknown, already used or expired. Show an invalid-or-expired link
 * message and offer a new one.
 */
class InvalidTokenException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_INVALID_TOKEN'
  static status = 400
}

/** @reexport */
export const E_ACCOUNT_KIT_INVALID_TOKEN = InvalidTokenException

/**
 * A rate limit is spent. `retryAfterSeconds` says when the caller may retry; send it as `Retry-
 * After`.
 */
class ThrottledException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_THROTTLED'
  static status = 429
  /** Seconds until the caller may retry. */
  readonly retryAfterSeconds: number

  static message = 'Too many requests'

  constructor(retryAfterSeconds: number, options?: ErrorOptions) {
    super(undefined, options)
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_THROTTLED = ThrottledException

/** An `authorize` callback denied the action, or public registration is closed. */
class AuthorizationException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_AUTHORIZATION'
  static status = 403
}

/** @reexport */
export const E_ACCOUNT_KIT_AUTHORIZATION = AuthorizationException

/**
 * `authorize.manageInvitation` denied a resend or revoke. Reported as not found so a caller cannot
 * tell a hidden invitation from a missing one.
 */
class InvitationManagementDeniedException extends AuthorizationException {
  static code = 'E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED'
  static status = 404
}

/** @reexport */
export const E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED = InvitationManagementDeniedException

/** Account inspection denied: the account is missing, restricted, or inactive when active was required. */
class AccountAccessDeniedException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED'
  static status = 403
  static message = 'Account access denied'
}

/** @reexport */
export const E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED = AccountAccessDeniedException

/** The invitation does not exist or is no longer pending. */
class InvitationNotFoundException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_INVITATION_NOT_FOUND'
  static status = 404
}

/** @reexport */
export const E_ACCOUNT_KIT_INVITATION_NOT_FOUND = InvitationNotFoundException

/** The sign-in to revoke does not exist or belongs to another user. */
class SessionNotFoundException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SESSION_NOT_FOUND'
  static status = 404
}

/** @reexport */
export const E_ACCOUNT_KIT_SESSION_NOT_FOUND = SessionNotFoundException

/**
 * A password or email change had a wrong or missing current password, or a social-only account had
 * no recent proof.
 */
class IdentityNotConfirmedException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED'
  static status = 403
}

/** @reexport */
export const E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED = IdentityNotConfirmedException

/**
 * A password or email change was attempted on an account without a local password while social
 * sign-in is disabled. Offer password reset to set a first password.
 */
class NoPasswordException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_NO_PASSWORD'
  static status = 403
}

/** @reexport */
export const E_ACCOUNT_KIT_NO_PASSWORD = NoPasswordException

/** An email change or invitation targets an address that already has an account. */
class EmailAlreadyRegisteredException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED'
  static status = 409
}

/** @reexport */
export const E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED = EmailAlreadyRegisteredException

/**
 * Registration used an address that already has an account. Has `field: 'email'` so it can be shown
 * as a field error.
 */
class RegistrationEmailAlreadyRegisteredException extends EmailAlreadyRegisteredException {
  // Both duplicate-address cases share the public code; signup carries its own status and field.
  static code = 'E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED'
  static status = 422
  /** The request field to attach the error to. */
  readonly field = 'email'
}

/** @reexport */
export const E_ACCOUNT_KIT_REGISTRATION_EMAIL_ALREADY_REGISTERED =
  RegistrationEmailAlreadyRegisteredException
/**
 * An operator command found no account for the address. Operator paths only; public flows never
 * reveal this.
 */
class UserNotFoundException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_USER_NOT_FOUND'
  static status = 404
  static message = 'No account uses that email address'
}

/** @reexport */
export const E_ACCOUNT_KIT_USER_NOT_FOUND = UserNotFoundException

/** An invitation to this address is already pending; resend it instead. */
class InvitationPendingException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_INVITATION_PENDING'
  static status = 409
}

/** @reexport */
export const E_ACCOUNT_KIT_INVITATION_PENDING = InvitationPendingException

/**
 * Delivery effects failed after the account change committed without an observer or commit-listener
 * failure. Do not repeat the operation.
 */
class DeliveryException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_DELIVERY'
  static status = 500
}

/** @reexport */
export const E_ACCOUNT_KIT_DELIVERY = DeliveryException

/**
 * A post-commit observer or commit listener failed. Any delivery failures from the same follow-up
 * batch are included in the cause. Do not repeat a committed mutation.
 * Read-only account inspection returns no snapshot; retry is safe when its dependencies satisfy
 * the documented read-only, retry-safe contract.
 */
class PostCommitException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_POST_COMMIT'
  static status = 500
  /** Always true: the transaction committed; an inspection snapshot may still be discarded. */
  readonly committed = true
}

/** @reexport */
export const E_ACCOUNT_KIT_POST_COMMIT = PostCommitException

/**
 * Single-use rows changed between the locked read and the delete that consumes them, so the
 * delete removed a different number of rows. The transaction rolls back; retry the operation.
 */
class ConsumedRowsChangedException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_CONSUMED_ROWS_CHANGED'
  static status = 500

  constructor(table: string) {
    super(`account_kit: ${table} rows changed while they were consumed`)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_CONSUMED_ROWS_CHANGED = ConsumedRowsChangedException

/**
 * Whether Account Kit reported a follow-up failure after committing the transaction.
 * Recovery depends on the operation. A committed mutation should never be replayed.
 *
 * @example
 * ```ts
 * import { E_ACCOUNT_KIT_DELIVERY, isCommittedFailure } from '@kevinjohn/adonisjs-account-kit'
 *
 * try {
 *   await kit.passwordReset.reset({ token, password })
 * } catch (error) {
 *   if (!isCommittedFailure(error)) throw error
 *   logger.error(
 *     {
 *       operation: 'password_reset.reset',
 *       failure: error instanceof E_ACCOUNT_KIT_DELIVERY ? 'delivery' : 'post_commit',
 *     },
 *     'Password reset follow-up failed'
 *   )
 * }
 * ```
 */
export function isCommittedFailure(
  error: unknown
): error is DeliveryException | PostCommitException {
  return error instanceof E_ACCOUNT_KIT_DELIVERY || error instanceof E_ACCOUNT_KIT_POST_COMMIT
}

/** An operation was called for a capability that is not in `enabled`. */
class CapabilityDisabledException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_CAPABILITY_DISABLED'
  static status = 500
}

/** @reexport */
export const E_ACCOUNT_KIT_CAPABILITY_DISABLED = CapabilityDisabledException

/**
 * Login failed. One error covers unknown email, wrong password, restricted and passwordless
 * accounts, so it reveals nothing about which.
 */
class InvalidCredentialsException extends AccountKitException {
  static code = 'E_INVALID_CREDENTIALS'
  // Official `@adonisjs/auth` uses 400; this package documents 401.
  static status = 401
  static message = 'Invalid email or password'
}

/** @reexport */
export const E_INVALID_CREDENTIALS = InvalidCredentialsException

/** The session or token is missing, revoked, or older than the latest credential change. */
class InvalidSessionException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_INVALID_SESSION'
  static status = 401
  static message = 'Invalid session'
}

/** @reexport */
export const E_ACCOUNT_KIT_INVALID_SESSION = InvalidSessionException

/** `requireActive` rejected an account that has not confirmed its email address. */
class UnverifiedEmailException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_UNVERIFIED_EMAIL'
  static status = 403
  static message = 'Email verification is required'
}

/** @reexport */
export const E_ACCOUNT_KIT_UNVERIFIED_EMAIL = UnverifiedEmailException

/** The social sign-in state is missing, expired or does not match. Restart the provider sign-in. */
class SocialTransactionException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID'
  static status = 400
  static message = 'Invalid social transaction'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID = SocialTransactionException

/** The provider account is already linked to a different user. */
class SocialIdentityAlreadyLinkedException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_IDENTITY_ALREADY_LINKED'
  static status = 409
  static message = 'Social identity is already linked'
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_IDENTITY_ALREADY_LINKED = SocialIdentityAlreadyLinkedException

/** The provider did not return an email address. */
class SocialEmailMissingException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_EMAIL_MISSING'
  static status = 422
  static message = 'Social email is required'
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_EMAIL_MISSING = SocialEmailMissingException

/** No account is linked to this provider identity. */
class SocialUserNotFoundException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND'
  static status = 404
  static message = 'Social account was not found'
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND = SocialUserNotFoundException

/** A sensitive social action lacks a valid recent authentication proof. */
class SocialProofException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID'
  static status = 403
  static message = 'Invalid recent authentication proof'
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID = SocialProofException

/** `socialAuthentication.acceptLink` refused to link this provider account. */
class SocialLinkRefusedException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_LINK_REFUSED'
  static status = 403
  static message = 'Social link refused'
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_LINK_REFUSED = SocialLinkRefusedException

/** Unlinking would leave the account without any way to sign in. */
class LastLoginMethodException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_LAST_LOGIN_METHOD'
  static status = 409
  static message = 'At least one login method must remain'
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_LAST_LOGIN_METHOD = LastLoginMethodException

/**
 * `require` ran for a person who is not admitted. `decision` says which requirement is unmet;
 * return it so the application can explain what is missing.
 */
class AdmissionRequiredException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_ADMISSION_REQUIRED'
  static status = 403
  /** The decision that refused the person. */
  readonly decision: AdmissionDecision

  static message = 'Admission is required'

  constructor(decision: AdmissionDecision) {
    super()
    this.decision = decision
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_ADMISSION_REQUIRED = AdmissionRequiredException

/** An approve, reject or revoke that the current approval state does not allow. */
class AdmissionDecisionException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_ADMISSION_DECISION'
  static status = 409
}

/** @reexport */
export const E_ACCOUNT_KIT_ADMISSION_DECISION = AdmissionDecisionException

/** The invitation committed, but its matching waiting approval is no longer available. */
class BootstrapApprovalChangedException extends InvalidInputException {
  // The command recognises this cause while reporting its existing input diagnostic code.
  static code = 'E_ACCOUNT_KIT_INVALID_INPUT'
  static status = 422
  static message = 'Bootstrap approval was replaced or cancelled. Run bootstrap again.'
}

/** @reexport */
export const E_ACCOUNT_KIT_BOOTSTRAP_APPROVAL_CHANGED = BootstrapApprovalChangedException

/** The application provider declarations cannot be inspected statically. */
class UnsupportedProvidersConfigurationException extends Exception {
  static code = 'E_ACCOUNT_KIT_UNSUPPORTED_PROVIDERS_CONFIGURATION'
  static status = 500

  constructor(message: string) {
    super(message)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_UNSUPPORTED_PROVIDERS_CONFIGURATION =
  UnsupportedProvidersConfigurationException

/** The application configuration uses a shape configure cannot inspect statically. */
class UnsupportedConfigShapeException extends Exception {
  static code = 'E_ACCOUNT_KIT_UNSUPPORTED_CONFIG_SHAPE'
  static status = 500

  constructor(message: string) {
    super(message)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_UNSUPPORTED_CONFIG_SHAPE = UnsupportedConfigShapeException

/** The retirement command received an unsupported or repeated provider. */
class InvalidProvidersFlagException extends Exception {
  static code = 'E_ACCOUNT_KIT_INVALID_PROVIDERS_FLAG'
  static status = 500

  constructor(message: string) {
    super(message)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INVALID_PROVIDERS_FLAG = InvalidProvidersFlagException

/** Setup cannot choose or read the Lucid migration directory; reported as a setup diagnostic. */
class MigrationDirectoryException extends Exception {
  static code = 'E_ACCOUNT_KIT_MIGRATION_DIRECTORY'
  static status = 500
  /** The setup diagnostic field: the directory at fault, or the database config that chose it. */
  readonly field: string

  constructor(message: string, field = 'config/database.ts') {
    super(message)
    this.field = field
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_MIGRATION_DIRECTORY = MigrationDirectoryException

/** Thrown when applying setup fails after some files were already published. */
class SetupApplyInterruptedException extends Exception {
  static code = 'E_ACCOUNT_KIT_SETUP_APPLY_INTERRUPTED'
  static status = 500
  readonly written: string[]

  constructor(written: string[], cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(
      `Setup failed after writing ${written.length} file(s): ${reason}. Already written: ${written.join(', ')}. Fix the cause and rerun setup; it continues from there.`,
      { cause }
    )
    this.written = written
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SETUP_APPLY_INTERRUPTED = SetupApplyInterruptedException

/** The source does not compile, so setup cannot inspect it. Planners report it against the file. */
class InvalidSetupSourceException extends Exception {
  static code = 'E_ACCOUNT_KIT_INVALID_SETUP_SOURCE'
  static status = 500
  static message = 'Setup cannot inspect invalid TypeScript source'

  constructor() {
    super()
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INVALID_SETUP_SOURCE = InvalidSetupSourceException

/** A selected assignment is empty, repeated, malformed or indirect: unresolved, not unsafe. */
class SelectedEnvironmentValueException extends Exception {
  static code = 'E_ACCOUNT_KIT_SELECTED_ENVIRONMENT_VALUE'
  static status = 500

  constructor(message: string) {
    super(message)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SELECTED_ENVIRONMENT_VALUE = SelectedEnvironmentValueException

/** A selected assignment refers to other values, so reading it would mean evaluating it. */
class IndirectEnvironmentValueException extends SelectedEnvironmentValueException {
  static code = 'E_ACCOUNT_KIT_INDIRECT_ENVIRONMENT_VALUE'
  static status = 500
  static message = 'Selected environment assignment must be a direct value'

  constructor() {
    super(IndirectEnvironmentValueException.message)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INDIRECT_ENVIRONMENT_VALUE = IndirectEnvironmentValueException
