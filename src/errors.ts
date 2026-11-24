import type { HttpContext } from '@adonisjs/core/http'
import { Exception, RuntimeException } from '@adonisjs/core/exceptions'
import type { AdmissionDecision } from './admission_decision.js'

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
    super(
      message ?? new.target.message ?? new.target.name,
      options && 'cause' in options ? { cause: options.cause } : undefined
    )
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
 * Base for faults in the values returned by an application adapter or guard. Clients get the generic `E_ACCOUNT_KIT_OPERATION_FAILED` 500 from the managed routes,
 * `accountErrorResponse` and `E_ACCOUNT_KIT.handle`. Managed routes log the error with the route
 * name through the request logger; on the application's own routes the AdonisJS exception handler
 * reports it, and a caller of `accountErrorResponse` logs it itself.
 */
class AdapterContractException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_ADAPTER_CONTRACT'
  static status = 500

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_ADAPTER_CONTRACT = AdapterContractException

/**
 * Input failed a package rule, for example a password outside the policy or a malformed email.
 * Validate requests first so users see field errors.
 */
class InvalidInputException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_INVALID_INPUT'
  static status = 422

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
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

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
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

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
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

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED = InvitationManagementDeniedException

/** Account inspection denied: the account is missing, restricted, or inactive when active was required. */
class AccountAccessDeniedException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED'
  static status = 403
  static message = 'Account access denied'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED = AccountAccessDeniedException

/** The invitation does not exist or is no longer pending. */
class InvitationNotFoundException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_INVITATION_NOT_FOUND'
  static status = 404

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INVITATION_NOT_FOUND = InvitationNotFoundException

/** The sign-in to revoke does not exist or belongs to another user. */
class SessionNotFoundException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SESSION_NOT_FOUND'
  static status = 404

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
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

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
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

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_NO_PASSWORD = NoPasswordException

/** An email change or invitation targets an address that already has an account. */
class EmailAlreadyRegisteredException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED'
  static status = 409

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED = EmailAlreadyRegisteredException

/**
 * Registration used an address that already has an account. Has `field: 'email'` so it can be shown
 * as a field error.
 */
class RegistrationEmailAlreadyRegisteredException extends EmailAlreadyRegisteredException {
  static code = 'E_ACCOUNT_KIT_REGISTRATION_EMAIL_ALREADY_REGISTERED'
  static status = 422
  /** The request field to attach the error to. */
  readonly field = 'email'

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
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

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_USER_NOT_FOUND = UserNotFoundException

/** An invitation to this address is already pending; resend it instead. */
class InvitationPendingException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_INVITATION_PENDING'
  static status = 409

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
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

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_DELIVERY = DeliveryException

/**
 * A post-commit observer failed. Transaction finalisation and activation issuance identify their
 * own causes. Any delivery failures from the same follow-up batch are included in the cause. Do not repeat a committed mutation.
 * Read-only account inspection returns no snapshot; retry is safe when its dependencies satisfy
 * the documented read-only, retry-safe contract.
 */
class PostCommitException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_POST_COMMIT'
  static status = 500
  /** Always true: the transaction committed; an inspection snapshot may still be discarded. */
  readonly committed = true

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_POST_COMMIT = PostCommitException

/**
 * Whether Account Kit reported a follow-up failure after committing the transaction.
 * Recovery depends on the operation. A committed mutation should never be replayed.
 *
 * @example
 * ```ts
 * import { isCommittedFailure } from '@kevinjohn/adonisjs-account-kit'
 *
 * try {
 *   await kit.passwordReset.reset({ token, password })
 * } catch (error) {
 *   if (!isCommittedFailure(error)) throw error
 *   logger.error({ err: error }, 'Password reset follow-up failed')
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

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_CAPABILITY_DISABLED = CapabilityDisabledException

/**
 * Base for credential rejection. The HTTP mapper masks the specific account and password causes.
 */
class InvalidCredentialsException extends AccountKitException {
  static code = 'E_INVALID_CREDENTIALS'
  // Official `@adonisjs/auth` uses 400; this package documents 401.
  static status = 401
  static message = 'Invalid email or password'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_INVALID_CREDENTIALS = InvalidCredentialsException

/** The session or token is missing, revoked, or older than the latest credential change. */
class InvalidSessionException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_INVALID_SESSION'
  static status = 401
  static message = 'Invalid session'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INVALID_SESSION = InvalidSessionException

/** `requireActive` rejected an account that has not confirmed its email address. */
class UnverifiedEmailException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_UNVERIFIED_EMAIL'
  static status = 403
  static message = 'Email verification is required'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
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

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_IDENTITY_ALREADY_LINKED = SocialIdentityAlreadyLinkedException

/** The provider did not return an email address. */
class SocialEmailMissingException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_EMAIL_MISSING'
  static status = 422
  static message = 'Social email is required'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_EMAIL_MISSING = SocialEmailMissingException

/** No account is linked to this provider identity. */
class SocialUserNotFoundException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND'
  static status = 404
  static message = 'Social account was not found'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND = SocialUserNotFoundException

/** A sensitive social action lacks a valid recent authentication proof. */
class SocialProofException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID'
  static status = 403
  static message = 'Invalid recent authentication proof'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID = SocialProofException

/** `socialAuthentication.acceptLink` refused to link this provider account. */
class SocialLinkRefusedException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_LINK_REFUSED'
  static status = 403
  static message = 'Social link refused'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_LINK_REFUSED = SocialLinkRefusedException

/** Unlinking would leave the account without any way to sign in. */
class LastLoginMethodException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_LAST_LOGIN_METHOD'
  static status = 409
  static message = 'At least one login method must remain'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
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

  constructor(decision: AdmissionDecision, options?: ErrorOptions) {
    super(undefined, options)
    this.decision = decision
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_ADMISSION_REQUIRED = AdmissionRequiredException

/** An approve, reject or revoke that the current approval state does not allow. */
class AdmissionDecisionException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_ADMISSION_DECISION'
  static status = 409

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_ADMISSION_DECISION = AdmissionDecisionException

/** The invitation committed, but its matching waiting approval is no longer available. */
class BootstrapApprovalChangedException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_BOOTSTRAP_APPROVAL_CHANGED'
  static status = 422
  static message = 'Bootstrap approval was replaced or cancelled. Run bootstrap again.'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_BOOTSTRAP_APPROVAL_CHANGED = BootstrapApprovalChangedException

/** The application provider declarations cannot be inspected statically. */
class UnsupportedProvidersConfigurationException extends Exception {
  static code = 'E_ACCOUNT_KIT_UNSUPPORTED_PROVIDERS_CONFIGURATION'
  static status = 500

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options && 'cause' in options ? { cause: options.cause } : undefined)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_UNSUPPORTED_PROVIDERS_CONFIGURATION =
  UnsupportedProvidersConfigurationException

/** The application configuration uses a shape configure cannot inspect statically. */
class UnsupportedConfigShapeException extends Exception {
  static code = 'E_ACCOUNT_KIT_UNSUPPORTED_CONFIG_SHAPE'
  static status = 500

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options && 'cause' in options ? { cause: options.cause } : undefined)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_UNSUPPORTED_CONFIG_SHAPE = UnsupportedConfigShapeException

/** The retirement command received an unsupported or repeated provider. */
class InvalidProvidersFlagException extends Exception {
  static code = 'E_ACCOUNT_KIT_INVALID_PROVIDERS_FLAG'
  static status = 500

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options && 'cause' in options ? { cause: options.cause } : undefined)
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

  constructor(message: string, field = 'config/database.ts', options?: ErrorOptions) {
    super(message, options && 'cause' in options ? { cause: options.cause } : undefined)
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

  constructor(written: string[], options?: ErrorOptions) {
    const cause = options?.cause
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(
      `Setup failed after writing ${written.length} file(s): ${reason}. Already written: ${written.join(', ')}. Fix the cause and rerun setup; it continues from there.`,
      options && 'cause' in options ? { cause } : undefined
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

  constructor(options?: ErrorOptions) {
    super(undefined, options && 'cause' in options ? { cause: options.cause } : undefined)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INVALID_SETUP_SOURCE = InvalidSetupSourceException

/** A selected assignment is empty, repeated, malformed or indirect: unresolved, not unsafe. */
class SelectedEnvironmentValueException extends Exception {
  static code = 'E_ACCOUNT_KIT_SELECTED_ENVIRONMENT_VALUE'
  static status = 500

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options && 'cause' in options ? { cause: options.cause } : undefined)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SELECTED_ENVIRONMENT_VALUE = SelectedEnvironmentValueException

/** A selected assignment refers to other values, so reading it would mean evaluating it. */
class IndirectEnvironmentValueException extends SelectedEnvironmentValueException {
  static code = 'E_ACCOUNT_KIT_INDIRECT_ENVIRONMENT_VALUE'
  static status = 500
  static message = 'Selected environment assignment must be a direct value'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INDIRECT_ENVIRONMENT_VALUE = IndirectEnvironmentValueException

/** The access policy returned a value other than a boolean. */
class InvalidAccessDecisionException extends AdapterContractException {
  static code = 'E_ACCOUNT_KIT_INVALID_ACCESS_DECISION'
  static status = 500
  static message = 'account_kit: canAccess must resolve to a boolean'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INVALID_ACCESS_DECISION = InvalidAccessDecisionException

/** The access-token provider returned no issued token. */
class TokenNotIssuedException extends AdapterContractException {
  static code = 'E_ACCOUNT_KIT_TOKEN_NOT_ISSUED'
  static status = 500
  static message = 'Token guard did not return a token'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_TOKEN_NOT_ISSUED = TokenNotIssuedException

/** The issued token cannot be identified safely for cleanup. */
class InvalidTokenIdentifierException extends AdapterContractException {
  static code = 'E_ACCOUNT_KIT_INVALID_TOKEN_IDENTIFIER'
  static status = 500
  static message = 'Token guard did not return a token identifier'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INVALID_TOKEN_IDENTIFIER = InvalidTokenIdentifierException

/** The issued credential has no releasable bearer value. */
class MissingBearerValueException extends AdapterContractException {
  static code = 'E_ACCOUNT_KIT_MISSING_BEARER_VALUE'
  static status = 500
  static message = 'Token guard did not return a bearer value'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_MISSING_BEARER_VALUE = MissingBearerValueException

/** The application policy closes public registration. */
class RegistrationClosedException extends AuthorizationException {
  static code = 'E_ACCOUNT_KIT_REGISTRATION_CLOSED'
  static status = 403

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_REGISTRATION_CLOSED = RegistrationClosedException

/** The account has no usable password credential or is no longer present. */
class CredentialsAccountUnavailableException extends InvalidCredentialsException {
  static code = 'E_ACCOUNT_KIT_CREDENTIALS_ACCOUNT_UNAVAILABLE'
  static status = 401

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_CREDENTIALS_ACCOUNT_UNAVAILABLE = CredentialsAccountUnavailableException

/** The password did not verify. */
class CredentialsPasswordMismatchException extends InvalidCredentialsException {
  static code = 'E_ACCOUNT_KIT_CREDENTIALS_PASSWORD_MISMATCH'
  static status = 401

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_CREDENTIALS_PASSWORD_MISMATCH = CredentialsPasswordMismatchException

/** The access policy denied the credential request. */
class CredentialsAccessDeniedException extends InvalidCredentialsException {
  static code = 'E_ACCOUNT_KIT_CREDENTIALS_ACCESS_DENIED'
  static status = 401

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_CREDENTIALS_ACCESS_DENIED = CredentialsAccessDeniedException

/** The credential request is malformed. */
class CredentialsInputInvalidException extends InvalidCredentialsException {
  static code = 'E_ACCOUNT_KIT_CREDENTIALS_INPUT_INVALID'
  static status = 401

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_CREDENTIALS_INPUT_INVALID = CredentialsInputInvalidException

/** A previously verified credential became invalid during issuance. */
class CredentialIssuanceRejectedException extends InvalidCredentialsException {
  static code = 'E_ACCOUNT_KIT_CREDENTIAL_ISSUANCE_REJECTED'
  static status = 401

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_CREDENTIAL_ISSUANCE_REJECTED = CredentialIssuanceRejectedException

/** The account to inspect is no longer present. */
class InspectionAccountMissingException extends AccountAccessDeniedException {
  static code = 'E_ACCOUNT_KIT_INSPECTION_ACCOUNT_MISSING'
  static status = 403

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INSPECTION_ACCOUNT_MISSING = InspectionAccountMissingException

/** The access policy denied the account being inspected. */
class InspectionAccountRestrictedException extends AccountAccessDeniedException {
  static code = 'E_ACCOUNT_KIT_INSPECTION_ACCOUNT_RESTRICTED'
  static status = 403

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INSPECTION_ACCOUNT_RESTRICTED = InspectionAccountRestrictedException

/** The caller required an active account and the inspected account is inactive. */
class InspectionAccountInactiveException extends AccountAccessDeniedException {
  static code = 'E_ACCOUNT_KIT_INSPECTION_ACCOUNT_INACTIVE'
  static status = 403

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INSPECTION_ACCOUNT_INACTIVE = InspectionAccountInactiveException

/** Transaction finalisation failed after the database commit. */
class CommittedTransactionFailedException extends PostCommitException {
  static code = 'E_ACCOUNT_KIT_COMMITTED_TRANSACTION_FAILED'
  static status = 500

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_COMMITTED_TRANSACTION_FAILED = CommittedTransactionFailedException

/** A social signup committed before its activation link could be issued. */
class SocialActivationFailedException extends PostCommitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_ACTIVATION_FAILED'
  static status = 500

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_ACTIVATION_FAILED = SocialActivationFailedException

/** A social provider failed to supply a usable callback profile or assurance. */
class SocialProviderFailedException extends SocialTransactionException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_PROVIDER_FAILED'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_PROVIDER_FAILED = SocialProviderFailedException

/** The provider matched a callback state but cannot verify fresh authentication. */
class SocialCallbackFreshAuthUnavailableException extends SocialProviderFailedException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_CALLBACK_FRESH_AUTH_UNAVAILABLE'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_CALLBACK_FRESH_AUTH_UNAVAILABLE =
  SocialCallbackFreshAuthUnavailableException

/** The one-use social handoff cannot be redeemed. */
class SocialHandoffInvalidException extends SocialTransactionException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_HANDOFF_INVALID'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_HANDOFF_INVALID = SocialHandoffInvalidException

/** The continuation or policy for social registration does not permit completion. */
class SocialRegistrationInvalidException extends SocialTransactionException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_REGISTRATION_INVALID'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_REGISTRATION_INVALID = SocialRegistrationInvalidException

/** Ordered failures from independent follow-up effects after an account operation committed. */
class CommittedEffectsFailedException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_COMMITTED_EFFECTS_FAILED'
  static status = 500

  constructor(
    /** Original failures in the order they were observed. */
    readonly errors: readonly unknown[],
    options?: ErrorOptions
  ) {
    super('Multiple committed effects failed', options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_COMMITTED_EFFECTS_FAILED = CommittedEffectsFailedException

/** Multiple failures while cleaning up a connection after successful transaction work. */
class TransactionCleanupFailedException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_TRANSACTION_CLEANUP_FAILED'
  static status = 500

  constructor(
    /** Original failures in the order they were observed. */
    readonly errors: readonly unknown[],
    options?: ErrorOptions
  ) {
    super('Transaction cleanup failed', options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_TRANSACTION_CLEANUP_FAILED = TransactionCleanupFailedException

/** Multiple failures while cleaning up a setup operation after successful work. */
class SetupCleanupFailedException extends Exception {
  static code = 'E_ACCOUNT_KIT_SETUP_CLEANUP_FAILED'
  static status = 500

  constructor(
    /** Original failures in the order they were observed. */
    readonly errors: readonly unknown[],
    options?: ErrorOptions
  ) {
    super(
      'Setup cleanup failed',
      options && 'cause' in options ? { cause: options.cause } : undefined
    )
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SETUP_CLEANUP_FAILED = SetupCleanupFailedException

/** The acting account does not exist. */
class ActorNotFoundException extends InvalidInputException {
  static code = 'E_ACCOUNT_KIT_ACTOR_NOT_FOUND'
  static status = 422
  static message = 'Unknown actor'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_ACTOR_NOT_FOUND = ActorNotFoundException

/** The supplied email address is malformed. */
class EmailInvalidException extends InvalidInputException {
  static code = 'E_ACCOUNT_KIT_EMAIL_INVALID'
  static status = 422
  static message = 'Invalid email'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_EMAIL_INVALID = EmailInvalidException

/** The request has no client challenge. */
class ClientChallengeRequiredException extends InvalidInputException {
  static code = 'E_ACCOUNT_KIT_CLIENT_CHALLENGE_REQUIRED'
  static status = 422
  static message = 'Client challenge is required'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_CLIENT_CHALLENGE_REQUIRED = ClientChallengeRequiredException

/** The credential no longer refers to an account. */
class SessionAccountMissingException extends InvalidSessionException {
  static code = 'E_ACCOUNT_KIT_SESSION_ACCOUNT_MISSING'
  static status = 401

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SESSION_ACCOUNT_MISSING = SessionAccountMissingException

/** The session lacks a matching credential revision. */
class SessionRevisionInvalidException extends InvalidSessionException {
  static code = 'E_ACCOUNT_KIT_SESSION_REVISION_INVALID'
  static status = 401

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SESSION_REVISION_INVALID = SessionRevisionInvalidException

/** The active bearer token is absent. */
class SessionTokenMissingException extends InvalidSessionException {
  static code = 'E_ACCOUNT_KIT_SESSION_TOKEN_MISSING'
  static status = 401

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SESSION_TOKEN_MISSING = SessionTokenMissingException

/** The application denied access for the current credential. */
class SessionAccessDeniedException extends InvalidSessionException {
  static code = 'E_ACCOUNT_KIT_SESSION_ACCESS_DENIED'
  static status = 401

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SESSION_ACCESS_DENIED = SessionAccessDeniedException

/** An existing account has no password. */
class CredentialsPasswordUnavailableException extends InvalidCredentialsException {
  static code = 'E_ACCOUNT_KIT_CREDENTIALS_PASSWORD_UNAVAILABLE'
  static status = 401

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_CREDENTIALS_PASSWORD_UNAVAILABLE =
  CredentialsPasswordUnavailableException

/** The actor tried to decide their own admission. */
class AdmissionSelfDecisionException extends AuthorizationException {
  static code = 'E_ACCOUNT_KIT_ADMISSION_SELF_DECISION'
  static status = 403
  static message = 'The actor cannot decide their own admission'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_ADMISSION_SELF_DECISION = AdmissionSelfDecisionException

/** The actor has not been admitted. */
class AdmissionActorNotAdmittedException extends AuthorizationException {
  static code = 'E_ACCOUNT_KIT_ADMISSION_ACTOR_NOT_ADMITTED'
  static status = 403
  static message = 'The actor is not admitted'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_ADMISSION_ACTOR_NOT_ADMITTED = AdmissionActorNotAdmittedException

/** The application denied the admission operation. */
class AdmissionPolicyDeniedException extends AuthorizationException {
  static code = 'E_ACCOUNT_KIT_ADMISSION_POLICY_DENIED'
  static status = 403
  static message = 'The application denied the admission operation'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_ADMISSION_POLICY_DENIED = AdmissionPolicyDeniedException

/** The account already has recorded invitation evidence. */
class AdmissionInvitationEvidenceExistsException extends AdmissionDecisionException {
  static code = 'E_ACCOUNT_KIT_ADMISSION_INVITATION_EVIDENCE_EXISTS'
  static status = 409
  static message = 'Invitation evidence is already recorded'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_ADMISSION_INVITATION_EVIDENCE_EXISTS =
  AdmissionInvitationEvidenceExistsException

/** The proof token has an invalid format. */
class ProofTokenMalformedException extends InvalidTokenException {
  static code = 'E_ACCOUNT_KIT_PROOF_TOKEN_MALFORMED'
  static status = 400
  static message = 'The proof token has an invalid format'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_PROOF_TOKEN_MALFORMED = ProofTokenMalformedException

/** The reset proof has no remaining account. */
class PasswordResetAccountMissingException extends InvalidTokenException {
  static code = 'E_ACCOUNT_KIT_PASSWORD_RESET_ACCOUNT_MISSING'
  static status = 400
  static message = 'The password reset account is missing'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_PASSWORD_RESET_ACCOUNT_MISSING = PasswordResetAccountMissingException

/** The callback has no client verifier. */
class MagicLinkVerifierRequiredException extends InvalidTokenException {
  static code = 'E_ACCOUNT_KIT_MAGIC_LINK_VERIFIER_REQUIRED'
  static status = 400
  static message = 'The sign-in link requires a client verifier'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_MAGIC_LINK_VERIFIER_REQUIRED = MagicLinkVerifierRequiredException

/** The provider profile has an invalid shape. */
class SocialProfileInvalidException extends SocialRegistrationInvalidException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_PROFILE_INVALID'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_PROFILE_INVALID = SocialProfileInvalidException

/** The inserted social identity could not be read back. */
class SocialIdentityNotPersistedException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_IDENTITY_NOT_PERSISTED'
  static status = 500
  static message = 'The inserted social identity could not be read back'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_IDENTITY_NOT_PERSISTED = SocialIdentityNotPersistedException

/** Registration policy is closed. */
class SocialRegistrationClosedException extends SocialRegistrationInvalidException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_REGISTRATION_CLOSED'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_REGISTRATION_CLOSED = SocialRegistrationClosedException

/** Application-controlled social registration has no admission callback. */
class SocialAdmissionCallbackRequiredException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_ADMISSION_CALLBACK_REQUIRED'
  static status = 500
  static message = 'Application-controlled social registration requires an admission callback'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_ADMISSION_CALLBACK_REQUIRED =
  SocialAdmissionCallbackRequiredException

/** Social registration cannot use an existing account email. */
class SocialRegistrationEmailConflictException extends SocialRegistrationInvalidException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_REGISTRATION_EMAIL_CONFLICT'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_REGISTRATION_EMAIL_CONFLICT =
  SocialRegistrationEmailConflictException

/** The new account could not be read back. */
class SocialAccountNotPersistedException extends AccountKitException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_ACCOUNT_NOT_PERSISTED'
  static status = 500
  static message = 'The new social account could not be read back'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_ACCOUNT_NOT_PERSISTED = SocialAccountNotPersistedException

/** The configured social adapter cannot verify fresh authentication. */
class SocialFreshAuthUnavailableException extends SocialProofException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_FRESH_AUTH_UNAVAILABLE'
  static status = 403

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_FRESH_AUTH_UNAVAILABLE = SocialFreshAuthUnavailableException

/** The submitted social proof has an invalid format. */
class SocialProofMalformedException extends SocialProofException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_PROOF_MALFORMED'
  static status = 403

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_PROOF_MALFORMED = SocialProofMalformedException

/** The social proof is absent, expired, consumed or obsolete. */
class SocialProofStaleException extends SocialProofException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_PROOF_STALE'
  static status = 403

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_PROOF_STALE = SocialProofStaleException

/** The social confirmation input is malformed. */
class SocialConfirmationInputInvalidException extends SocialTransactionException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_CONFIRMATION_INPUT_INVALID'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_CONFIRMATION_INPUT_INVALID =
  SocialConfirmationInputInvalidException

/** The social confirmation proof is absent. */
class SocialConfirmationStateMissingException extends SocialTransactionException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_CONFIRMATION_STATE_MISSING'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_CONFIRMATION_STATE_MISSING =
  SocialConfirmationStateMissingException

/** The confirmation proof no longer matches an eligible account. */
class SocialConfirmationAccountInvalidException extends SocialTransactionException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_CONFIRMATION_ACCOUNT_INVALID'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_CONFIRMATION_ACCOUNT_INVALID =
  SocialConfirmationAccountInvalidException

/** The pending provider identity is absent. */
class SocialConfirmationIdentityMissingException extends SocialTransactionException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_CONFIRMATION_IDENTITY_MISSING'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_CONFIRMATION_IDENTITY_MISSING =
  SocialConfirmationIdentityMissingException

/** The handoff input is malformed. */
class SocialHandoffInputInvalidException extends SocialHandoffInvalidException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_HANDOFF_INPUT_INVALID'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_HANDOFF_INPUT_INVALID = SocialHandoffInputInvalidException

/** The handoff is absent, expired or already used. */
class SocialHandoffMissingException extends SocialHandoffInvalidException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_HANDOFF_MISSING'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_HANDOFF_MISSING = SocialHandoffMissingException

/** The handoff no longer permits credential issuance. */
class SocialHandoffRejectedException extends SocialHandoffInvalidException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_HANDOFF_REJECTED'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_HANDOFF_REJECTED = SocialHandoffRejectedException

/** The service has already resolved its callbacks. */
class CallbackRegistrationTooLateException extends InvalidConfigurationException {
  static code = 'E_ACCOUNT_KIT_CALLBACK_REGISTRATION_TOO_LATE'
  static status = 500

  constructor(serviceName: string, options?: ErrorOptions) {
    super(
      'callbacks',
      `account_kit: callbacks must be registered before ${serviceName} is first resolved`,
      options
    )
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_CALLBACK_REGISTRATION_TOO_LATE = CallbackRegistrationTooLateException

/** A callback factory is already registered. */
class CallbackAlreadyRegisteredException extends InvalidConfigurationException {
  static code = 'E_ACCOUNT_KIT_CALLBACK_ALREADY_REGISTERED'
  static status = 500
  static message = 'account_kit: callbacks are already registered'

  constructor(options?: ErrorOptions) {
    super('callbacks', CallbackAlreadyRegisteredException.message, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_CALLBACK_ALREADY_REGISTERED = CallbackAlreadyRegisteredException

/** Setup cannot infer a migration directory. */
class MigrationDirectoryUnresolvedException extends MigrationDirectoryException {
  static code = 'E_ACCOUNT_KIT_MIGRATION_DIRECTORY_UNRESOLVED'
  static status = 500
  static message =
    'Unable to determine the Lucid migration directory statically; pass --migration-directory with the application-relative directory used by the selected connection'

  constructor(options?: ErrorOptions) {
    super(MigrationDirectoryUnresolvedException.message, undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_MIGRATION_DIRECTORY_UNRESOLVED = MigrationDirectoryUnresolvedException

/** The explicit directory conflicts with the configured directory. */
class MigrationDirectoryConflictException extends MigrationDirectoryException {
  static code = 'E_ACCOUNT_KIT_MIGRATION_DIRECTORY_CONFLICT'
  static status = 500
  static message =
    'The explicit migration directory differs from the configured Lucid migration directory'

  constructor(options?: ErrorOptions) {
    super(MigrationDirectoryConflictException.message, undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_MIGRATION_DIRECTORY_CONFLICT = MigrationDirectoryConflictException

/** Account Kit migrations already exist in a different directory. */
class MigrationDirectoryDuplicateException extends MigrationDirectoryException {
  static code = 'E_ACCOUNT_KIT_MIGRATION_DIRECTORY_DUPLICATE'
  static status = 500
  static message =
    'Account Kit migrations already exist in database/migrations; reconcile the migration paths and applied history manually before generating another copy'

  constructor(options?: ErrorOptions) {
    super(MigrationDirectoryDuplicateException.message, 'database/migrations', options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_MIGRATION_DIRECTORY_DUPLICATE = MigrationDirectoryDuplicateException

/** The selected assignment has multiple possible readings. */
class EnvAssignmentAmbiguousException extends SelectedEnvironmentValueException {
  static code = 'E_ACCOUNT_KIT_ENV_ASSIGNMENT_AMBIGUOUS'
  static status = 500

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_ENV_ASSIGNMENT_AMBIGUOUS = EnvAssignmentAmbiguousException

/** The selected assignment cannot be parsed. */
class EnvAssignmentMalformedException extends SelectedEnvironmentValueException {
  static code = 'E_ACCOUNT_KIT_ENV_ASSIGNMENT_MALFORMED'
  static status = 500
  static message = 'Selected environment assignment is malformed'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_ENV_ASSIGNMENT_MALFORMED = EnvAssignmentMalformedException

/** The selected value fails its domain validation. */
class EnvValueInvalidException extends SelectedEnvironmentValueException {
  static code = 'E_ACCOUNT_KIT_ENV_VALUE_INVALID'
  static status = 500

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_ENV_VALUE_INVALID = EnvValueInvalidException

/** The supplied guard differs from the configured guard. */
class SocialHandoffGuardMismatchException extends SocialHandoffInvalidException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_HANDOFF_GUARD_MISMATCH'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_HANDOFF_GUARD_MISMATCH = SocialHandoffGuardMismatchException

/** The request for a password-based social proof is malformed. */
class SocialPasswordInputInvalidException extends SocialProofException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_PASSWORD_INPUT_INVALID'
  static status = 403

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_PASSWORD_INPUT_INVALID = SocialPasswordInputInvalidException

/** The account has no matching password for a new social proof. */
class SocialPasswordRejectedException extends SocialProofException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_PASSWORD_REJECTED'
  static status = 403

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_PASSWORD_REJECTED = SocialPasswordRejectedException

/** The invitation proof is missing, expired or already used. */
class InvitationProofMissingException extends InvalidTokenException {
  static code = 'E_ACCOUNT_KIT_INVITATION_PROOF_MISSING'
  static status = 400
  static message = 'The invitation proof is missing, expired or already used.'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INVITATION_PROOF_MISSING = InvitationProofMissingException

/** The account could not be reloaded after accepting the invitation. */
class InvitationAccountMissingException extends InvalidTokenException {
  static code = 'E_ACCOUNT_KIT_INVITATION_ACCOUNT_MISSING'
  static status = 400
  static message = 'The account could not be reloaded after accepting the invitation.'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_INVITATION_ACCOUNT_MISSING = InvitationAccountMissingException

/** The account could not be reloaded after changing its email address. */
class EmailChangeAccountMissingException extends InvalidTokenException {
  static code = 'E_ACCOUNT_KIT_EMAIL_CHANGE_ACCOUNT_MISSING'
  static status = 400
  static message = 'The account could not be reloaded after changing its email address.'

  constructor(options?: ErrorOptions) {
    super(undefined, options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_EMAIL_CHANGE_ACCOUNT_MISSING = EmailChangeAccountMissingException

/** The client verifier did not match the handoff. */
class SocialHandoffVerifierMismatchException extends SocialHandoffInvalidException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_HANDOFF_VERIFIER_MISMATCH'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_HANDOFF_VERIFIER_MISMATCH = SocialHandoffVerifierMismatchException

/** The handoff account binding changed before the proof was consumed. */
class SocialHandoffAccountChangedException extends SocialHandoffInvalidException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_HANDOFF_ACCOUNT_CHANGED'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_HANDOFF_ACCOUNT_CHANGED = SocialHandoffAccountChangedException

/** The handoff no longer refers to an existing account. */
class SocialHandoffAccountMissingException extends SocialHandoffInvalidException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_HANDOFF_ACCOUNT_MISSING'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_HANDOFF_ACCOUNT_MISSING = SocialHandoffAccountMissingException

/** The access policy denied this social credential request. */
class SocialHandoffAccessDeniedException extends SocialHandoffInvalidException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_HANDOFF_ACCESS_DENIED'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_HANDOFF_ACCESS_DENIED = SocialHandoffAccessDeniedException

/** The handoff was issued at an obsolete credential revision. */
class SocialHandoffRevisionStaleException extends SocialHandoffInvalidException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_HANDOFF_REVISION_STALE'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_HANDOFF_REVISION_STALE = SocialHandoffRevisionStaleException

/** The handoff no longer refers to a usable provider identity. */
class SocialHandoffProviderMissingException extends SocialHandoffInvalidException {
  static code = 'E_ACCOUNT_KIT_SOCIAL_HANDOFF_PROVIDER_MISSING'
  static status = 400

  constructor(options?: ErrorOptions) {
    super(options)
  }
}

/** @reexport */
export const E_ACCOUNT_KIT_SOCIAL_HANDOFF_PROVIDER_MISSING = SocialHandoffProviderMissingException
