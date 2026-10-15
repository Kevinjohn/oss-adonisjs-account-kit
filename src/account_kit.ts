import { pruneExpired, type PruneInput } from './maintenance.js'
import { CapabilityDisabledError } from './errors.js'
import type { Encryption } from '@adonisjs/core/encryption'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import {
  inspectPasswordReset,
  requestPasswordReset,
  completePasswordReset,
} from './password_reset.js'
import { authenticationService } from './authentication.js'
import { register } from './registration.js'
import { completeVerification, inspectVerification, sendVerification } from './verification.js'
import {
  changePassword,
  completeEmailChange,
  inspectEmailChange,
  requestEmailChange,
  updateProfile,
} from './credentials.js'
import { consume } from './throttle.js'
import {
  acceptInvitation,
  inspectInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  sendInvitation,
} from './invitations.js'
import type {
  AccountUser,
  ChangePasswordInput,
  CompleteEmailChangeInput,
  InspectEmailChangeInput,
  RequestEmailChangeInput,
  UpdateProfileInput,
  Invitation,
  InvitationPage,
  Capability,
  InvitationsAcceptInput,
  InvitationsInspectInput,
  InvitationsListInput,
  InvitationsResendInput,
  InvitationsRevokeInput,
  InvitationsSendInput,
  PasswordResetInspectInput,
  PasswordResetRequestInput,
  PasswordResetCompleteInput,
  ResolvedConfig,
  RegistrationInput,
  VerificationCompleteInput,
  VerificationInspectInput,
  VerificationSendInput,
} from './types.js'

export { defineConfig } from './config.js'

export class AccountKit {
  constructor(
    private readonly deps: {
      config: ResolvedConfig
      db: Database
      encryption: Encryption
      limiter: LimiterService
    }
  ) {}

  private enabled<T>(capability: Capability, run: () => Promise<T>): Promise<T> {
    if (!this.deps.config.enabled.includes(capability))
      return Promise.reject(new CapabilityDisabledError(`${capability} is disabled`))
    return run()
  }

  readonly maintenance = {
    prune: (input: PruneInput = {}) => pruneExpired(this.deps.db, input),
  }

  /** Shared-store, secret-keyed client budget for managed proof URL requests. */
  readonly managedHttp = {
    assertGuard: (guard: { name: string; strategy: 'session' | 'access_tokens' }): void => {
      const selected = this.deps.config.authentication
      if (!selected || selected.guard !== guard.name || selected.strategy !== guard.strategy)
        throw new Error('Managed routes must use the configured existing authentication guard')
    },
    consume: (input: { endpoint: string; clientKey: string }): Promise<void> => {
      if (!input.clientKey)
        return Promise.reject(new Error('Managed request client key is required'))
      return consume(
        this.deps.limiter,
        `managed:${input.endpoint}`,
        input.clientKey,
        this.deps.config.throttle,
        this.deps.config.limiterSecret,
        this.deps.config.limiterNamespace
      )
    },
  }

  get authentication() {
    return authenticationService(this.deps)
  }

  readonly registration = {
    register: (input: RegistrationInput): Promise<AccountUser> =>
      this.enabled('registration', () => register(this.deps, input)),
  }

  readonly passwordReset = {
    request: (input: PasswordResetRequestInput): Promise<void> =>
      this.enabled('passwordReset', () => requestPasswordReset(this.deps, input)),
    inspect: (input: PasswordResetInspectInput): Promise<boolean> =>
      this.enabled('passwordReset', () => inspectPasswordReset(this.deps, input)),
    reset: (input: PasswordResetCompleteInput): Promise<AccountUser> =>
      this.enabled('passwordReset', () => completePasswordReset(this.deps, input)),
  }
  readonly emailVerification = {
    send: (input: VerificationSendInput): Promise<'sent' | 'already_verified'> =>
      this.enabled('emailVerification', () => sendVerification(this.deps, input)),
    inspect: (input: VerificationInspectInput): Promise<boolean> =>
      this.enabled('emailVerification', () => inspectVerification(this.deps, input)),
    complete: (input: VerificationCompleteInput): Promise<'verified'> =>
      this.enabled('emailVerification', () => completeVerification(this.deps, input)),
  }
  readonly invitations = {
    send: (input: InvitationsSendInput): Promise<Invitation> =>
      this.enabled('invitations', () => sendInvitation(this.deps, input)),
    list: (input: InvitationsListInput): Promise<InvitationPage> =>
      this.enabled('invitations', () => listInvitations(this.deps, input)),
    inspect: (input: InvitationsInspectInput): Promise<Pick<Invitation, 'email' | 'role'> | null> =>
      this.enabled('invitations', () => inspectInvitation(this.deps.db, input)),
    accept: (input: InvitationsAcceptInput): Promise<AccountUser> =>
      this.enabled('invitations', () => acceptInvitation(this.deps, input)),
    resend: (input: InvitationsResendInput): Promise<Invitation> =>
      this.enabled('invitations', () => resendInvitation(this.deps, input)),
    revoke: (input: InvitationsRevokeInput): Promise<void> =>
      this.enabled('invitations', () => revokeInvitation(this.deps, input)),
  }
  readonly emailPasswordManagement = {
    changePassword: (input: ChangePasswordInput): Promise<void> =>
      this.enabled('emailPasswordManagement', () => changePassword(this.deps, input)),
    requestEmailChange: (input: RequestEmailChangeInput): Promise<void> =>
      this.enabled('emailPasswordManagement', () => requestEmailChange(this.deps, input)),
    updateProfile: (input: UpdateProfileInput): Promise<AccountUser> =>
      this.enabled('emailPasswordManagement', () => updateProfile(this.deps, input)),
    inspectEmailChange: (input: InspectEmailChangeInput): Promise<boolean> =>
      this.enabled('emailPasswordManagement', () => inspectEmailChange(this.deps, input)),
    completeEmailChange: (input: CompleteEmailChangeInput): Promise<AccountUser> =>
      this.enabled('emailPasswordManagement', () => completeEmailChange(this.deps, input)),
  }
}
