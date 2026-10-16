import { Exception } from '@adonisjs/core/exceptions'

export class AccountKitError extends Exception {
  static code = 'E_ACCOUNT_KIT'
  static status = 500
  declare code: string

  constructor(message = new.target.name, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}
export class InvalidInputError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_INVALID_INPUT'
  static status = 422
}
export class InvalidTokenError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_INVALID_TOKEN'
  static status = 422
}
export class ThrottledError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_THROTTLED'
  static status = 429
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number, message = 'Too many requests', options?: ErrorOptions) {
    super(message, options)
    this.retryAfterSeconds = retryAfterSeconds
  }
}
export class AuthorizationError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_AUTHORIZATION'
  static status = 403
}
export class InvitationManagementDeniedError extends AuthorizationError {
  static code = 'E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED'
  static status = 404
}
export class InvitationNotFoundError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_INVITATION_NOT_FOUND'
  static status = 404
}
export class IdentityNotConfirmedError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED'
  static status = 403
}
export class NoPasswordError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_NO_PASSWORD'
  static status = 403
}
export class EmailAlreadyRegisteredError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED'
  static status = 409
}
export class RegistrationEmailAlreadyRegisteredError extends EmailAlreadyRegisteredError {
  static status = 422
  readonly field = 'email'
}
export class InvitationPendingError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_INVITATION_PENDING'
  static status = 409
}
export class DeliveryError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_DELIVERY'
}
export class PostCommitError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_POST_COMMIT'
  readonly committed = true
}
export class CapabilityDisabledError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_CAPABILITY_DISABLED'
}
export class InvalidCredentialsError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_INVALID_CREDENTIALS'
  static status = 400
  constructor() {
    super('Invalid email or password')
  }
}
export class InvalidSessionError extends AccountKitError {
  static code = 'E_ACCOUNT_KIT_INVALID_SESSION'
  static status = 401
  constructor() {
    super('Invalid session')
  }
}
export class UnverifiedEmailError extends AccountKitError {
  static code = 'unverified_email'
  static status = 403
  constructor() {
    super('unverified_email')
  }
}
export class SocialTransactionError extends AccountKitError {
  static code = 'E_SOCIAL_TRANSACTION_INVALID'
  static status = 400
  constructor(options?: ErrorOptions) {
    super('Invalid social transaction', options)
  }
}
export class SocialIdentityAlreadyLinkedError extends AccountKitError {
  static code = 'E_SOCIAL_IDENTITY_ALREADY_LINKED'
  static status = 409
  constructor() {
    super('Social identity is already linked')
  }
}
export class SocialEmailMissingError extends AccountKitError {
  static code = 'E_SOCIAL_EMAIL_MISSING'
  static status = 422
  constructor() {
    super('Social email is required')
  }
}
export class SocialUserNotFoundError extends AccountKitError {
  static code = 'E_SOCIAL_USER_NOT_FOUND'
  static status = 404
  constructor() {
    super('Social account was not found')
  }
}
export class SocialProofError extends AccountKitError {
  static code = 'E_SOCIAL_PROOF_INVALID'
  static status = 403
  constructor() {
    super('Invalid recent authentication proof')
  }
}
export class LastLoginMethodError extends AccountKitError {
  static code = 'E_SOCIAL_LAST_LOGIN_METHOD'
  static status = 409
  constructor() {
    super('At least one login method must remain')
  }
}
