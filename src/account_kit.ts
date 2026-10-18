import { pruneExpired, type PruneInput } from './maintenance.js'
import { AuthorizationError, CapabilityDisabledError } from './errors.js'
import type { Encryption } from '@adonisjs/core/encryption'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import {
  inspectPasswordReset,
  requestPasswordReset,
  completePasswordReset,
} from './password_reset.js'
import { authenticationService } from './authentication.js'
import { completeMagicLink, inspectMagicLink, requestMagicLink } from './magic_link.js'
import { sessionManagementService } from './session_management.js'
import { register } from './registration.js'
import { completeVerification, inspectVerification, sendVerification } from './verification.js'
import {
  changePassword,
  completeEmailChange,
  inspectEmailChange,
  requestEmailChange,
  updateProfile,
} from './credentials.js'
import { makeThrottler, type Throttler } from './throttle.js'
import { isPasswordAllowed } from './password.js'
import { socialIdentityService } from './social_identity.js'
import { operatorInvite, operatorResetLink } from './operator.js'
import { exportAccountData } from './account_export.js'
import { deleteAccount } from './account_deletion.js'
import {
  acceptInvitation,
  inspectInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  sendInvitation,
} from './invitations.js'
import type {
  AccountDataInput,
  AccountExport,
  AccountUser,
  AuthenticationGuard,
  ChangePasswordInput,
  CurrentAccount,
  MagicLinkCompleteInput,
  MagicLinkInspectInput,
  MagicLinkRequestInput,
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
  OperatorInviteInput,
  OperatorInviteResult,
  OperatorResetLinkInput,
  OperatorResetLinkResult,
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
  private readonly deps: {
    config: ResolvedConfig
    db: Database
    encryption?: Encryption
    limiter: LimiterService
    throttler: Throttler
  }

  constructor(deps: {
    config: ResolvedConfig
    db: Database
    encryption?: Encryption
    limiter: LimiterService
  }) {
    this.deps = {
      ...deps,
      throttler: makeThrottler({
        limiter: deps.limiter,
        secret: deps.config.limiterSecret,
        namespace: deps.config.limiterNamespace,
      }),
    }
  }

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
    passwordAllowed: (value: unknown): value is string =>
      isPasswordAllowed(value, this.deps.config.passwordPolicy),
    assertPublicRegistration: (): void => {
      if (this.deps.config.registration.availability !== 'open')
        throw new AuthorizationError('Public registration is unavailable')
    },
    assertGuard: (guard: { name: string; strategy: 'session' | 'access_tokens' }): void => {
      const selected = this.deps.config.authentication
      if (!selected || selected.guard !== guard.name || selected.strategy !== guard.strategy)
        throw new Error('Managed routes must use the configured existing authentication guard')
    },
    consume: (input: { endpoint: string; clientKey: string }): Promise<void> => {
      if (!input.clientKey)
        return Promise.reject(new Error('Managed request client key is required'))
      return this.deps.throttler.consume(
        `managed:${input.endpoint}`,
        input.clientKey,
        this.deps.config.throttle
      )
    },
  }

  get authentication() {
    return {
      ...authenticationService(this.deps),
      /** Where the user is signed in; requires `sessionManagement`. */
      sessions: sessionManagementService(this.deps),
    }
  }

  readonly registration = {
    register: (input: RegistrationInput): Promise<AccountUser> =>
      this.enabled('registration', () => register(this.deps, input)),
  }

  get socialAuthentication() {
    if (!this.deps.config.enabled.includes('socialAuthentication'))
      throw new CapabilityDisabledError('Social authentication is disabled')
    return socialIdentityService(this.deps)
  }

  /** Passwordless sign-in by an email link bound to the requesting client. */
  readonly magicLink = {
    request: (input: MagicLinkRequestInput): Promise<void> =>
      this.enabled('magicLinkLogin', () => requestMagicLink(this.deps, input)),
    inspect: (input: MagicLinkInspectInput): Promise<boolean> =>
      this.enabled('magicLinkLogin', () => inspectMagicLink(this.deps, input)),
    complete: <Credential>(
      input: MagicLinkCompleteInput,
      guard: AuthenticationGuard<Credential>
    ): Promise<{ account: CurrentAccount; credential: Credential }> =>
      this.enabled('magicLinkLogin', () => completeMagicLink(this.deps, input, guard)),
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
  /**
   * Operator context only: callers with shell access (Ace commands). No actor authorisation and no
   * throttles apply; never expose these methods to an HTTP request.
   */
  readonly operator = {
    invite: (input: OperatorInviteInput): Promise<OperatorInviteResult> =>
      this.enabled('invitations', () => operatorInvite(this.deps, input)),
    resetLink: (input: OperatorResetLinkInput): Promise<OperatorResetLinkResult> =>
      this.enabled('passwordReset', () => operatorResetLink(this.deps, input)),
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
  readonly accountData = {
    export: (input: AccountDataInput): Promise<AccountExport> =>
      this.enabled('dataExport', () => exportAccountData(this.deps, input)),
    delete: (input: AccountDataInput): Promise<void> =>
      this.enabled('accountDeletion', () => deleteAccount(this.deps, input)),
  }
}
