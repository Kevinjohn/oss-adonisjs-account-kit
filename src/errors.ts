export class AccountKitError extends Error {
  readonly code: string

  constructor(message = new.target.name, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
    this.code = this.name
  }
}

export class InvalidInputError extends AccountKitError {}
export class InvalidTokenError extends AccountKitError {}

export class ThrottledError extends AccountKitError {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number, message = 'Too many requests', options?: ErrorOptions) {
    super(message, options)
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export class AuthorizationError extends AccountKitError {}
export class IdentityNotConfirmedError extends AccountKitError {}
export class NoPasswordError extends AccountKitError {}
export class EmailAlreadyRegisteredError extends AccountKitError {}
export class InvitationPendingError extends AccountKitError {}
export class DeliveryError extends AccountKitError {}
export class PostCommitError extends AccountKitError {}
