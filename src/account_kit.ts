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
import { managedHttpService } from './managed_http_service.js'
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

/**
 * The account service. Resolve it from the container with `app.container.make(AccountKit)`; each
 * group below belongs to one capability and throws `CapabilityDisabledError` when that capability
 * is not in `enabled`.
 */
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

  /** Housekeeping for scheduled jobs. */
  readonly maintenance = {
    /**
     * Deletes expired tokens, invitations, social states and sign-ins in batches. `account-
     * kit:prune` calls it.
     */
    prune: (input: PruneInput = {}) => pruneExpired(this.deps.db, input),
  }

  /** Shared-store, secret-keyed client budget for managed proof URL requests. */
  get managedHttp() {
    return managedHttpService(this.deps)
  }

  /**
   * Login, the current account, restrictions, and signed-in devices. Needs the `authentication`
   * config.
   */
  get authentication() {
    return {
      ...authenticationService(this.deps),
      /** Where the user is signed in; requires `sessionManagement`. */
      sessions: sessionManagementService(this.deps),
    }
  }

  /** Self-service signup, for `registration`. */
  readonly registration = {
    /**
     * Creates an account under the configured admission policy and sends the confirmation link.
     * Throws `RegistrationEmailAlreadyRegisteredError` for a taken address.
     */
    register: (input: RegistrationInput): Promise<AccountUser> =>
      this.enabled('registration', () => register(this.deps, input)),
  }

  /** Google and GitHub sign-in, linking and recent proof, for `socialAuthentication`. */
  get socialAuthentication() {
    if (!this.deps.config.enabled.includes('socialAuthentication'))
      throw new CapabilityDisabledError('Social authentication is disabled')
    return socialIdentityService(this.deps)
  }

  /** Passwordless sign-in by an email link bound to the requesting client. */
  readonly magicLink = {
    /**
     * Emails a sign-in link. Answers the same way, after `minRequestMs`, whether or not the address
     * has an account.
     */
    request: (input: MagicLinkRequestInput): Promise<void> =>
      this.enabled('magicLinkLogin', () => requestMagicLink(this.deps, input)),
    /** Whether a sign-in link is still usable, without using it up. */
    inspect: (input: MagicLinkInspectInput): Promise<boolean> =>
      this.enabled('magicLinkLogin', () => inspectMagicLink(this.deps, input)),
    /**
     * Uses the link once and signs the user in through `guard`. The verifier must match the
     * challenge sent with the request.
     */
    complete: <Credential>(
      input: MagicLinkCompleteInput,
      guard: AuthenticationGuard<Credential>
    ): Promise<{ account: CurrentAccount; credential: Credential }> =>
      this.enabled('magicLinkLogin', () => completeMagicLink(this.deps, input, guard)),
  }

  /** Forgot-password links, for `passwordReset`. */
  readonly passwordReset = {
    /**
     * Emails a reset link to a known address. Answers the same way, after `minRequestMs`, whether
     * or not the address has an account.
     */
    request: (input: PasswordResetRequestInput): Promise<void> =>
      this.enabled('passwordReset', () => requestPasswordReset(this.deps, input)),
    /** Whether a reset link is still usable, without using it up. */
    inspect: (input: PasswordResetInspectInput): Promise<boolean> =>
      this.enabled('passwordReset', () => inspectPasswordReset(this.deps, input)),
    /**
     * Uses the link once, sets the new password, ends older sessions and tokens, and sends the
     * completed notice. Throws `InvalidTokenError` for a bad link.
     */
    reset: (input: PasswordResetCompleteInput): Promise<AccountUser> =>
      this.enabled('passwordReset', () => completePasswordReset(this.deps, input)),
  }
  /** Account activation links, for `emailVerification`. */
  readonly emailVerification = {
    /** Sends a new activation link, or returns `already_verified`. */
    send: (input: VerificationSendInput): Promise<'sent' | 'already_verified'> =>
      this.enabled('emailVerification', () => sendVerification(this.deps, input)),
    /** Whether an activation link is still usable, without using it up. */
    inspect: (input: VerificationInspectInput): Promise<boolean> =>
      this.enabled('emailVerification', () => inspectVerification(this.deps, input)),
    /** Uses the link once, confirms the address and sets the password. */
    complete: (input: VerificationCompleteInput): Promise<'verified'> =>
      this.enabled('emailVerification', () => completeVerification(this.deps, input)),
  }
  /** Invitations with roles, for `invitations`. Every action checks your `authorize` callbacks. */
  readonly invitations = {
    /** Invites an address with a role and emails the link. */
    send: (input: InvitationsSendInput): Promise<Invitation> =>
      this.enabled('invitations', () => sendInvitation(this.deps, input)),
    /** Lists pending invitations a page at a time. */
    list: (input: InvitationsListInput): Promise<InvitationPage> =>
      this.enabled('invitations', () => listInvitations(this.deps, input)),
    /** The email and role of a pending invitation, or null, without using the link. */
    inspect: (input: InvitationsInspectInput): Promise<Pick<Invitation, 'email' | 'role'> | null> =>
      this.enabled('invitations', () => inspectInvitation(this.deps.db, input)),
    /**
     * Uses the link once, creates the account and runs `onInvitationAccepted` in the same
     * transaction.
     */
    accept: (input: InvitationsAcceptInput): Promise<AccountUser> =>
      this.enabled('invitations', () => acceptInvitation(this.deps, input)),
    /** Replaces the invitation's link and emails it again. */
    resend: (input: InvitationsResendInput): Promise<Invitation> =>
      this.enabled('invitations', () => resendInvitation(this.deps, input)),
    /** Deletes a pending invitation. */
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
  /**
   * Account settings, for `emailPasswordManagement`. Changes need the current password, or a recent
   * proof for a social-only account.
   */
  readonly emailPasswordManagement = {
    /** Changes the password, ends older sessions and tokens, and sends the changed notice. */
    changePassword: (input: ChangePasswordInput): Promise<void> =>
      this.enabled('emailPasswordManagement', () => changePassword(this.deps, input)),
    /**
     * Emails a confirmation link to the new address. The email changes only when it is confirmed.
     */
    requestEmailChange: (input: RequestEmailChangeInput): Promise<void> =>
      this.enabled('emailPasswordManagement', () => requestEmailChange(this.deps, input)),
    /** Updates profile fields, and starts an email change when `email` differs. */
    updateProfile: (input: UpdateProfileInput): Promise<AccountUser> =>
      this.enabled('emailPasswordManagement', () => updateProfile(this.deps, input)),
    /** Whether an email-change link is still usable, without using it up. */
    inspectEmailChange: (input: InspectEmailChangeInput): Promise<boolean> =>
      this.enabled('emailPasswordManagement', () => inspectEmailChange(this.deps, input)),
    /**
     * Uses the link once, switches the address, ends older sessions and tokens, and tells the old
     * address.
     */
    completeEmailChange: (input: CompleteEmailChangeInput): Promise<AccountUser> =>
      this.enabled('emailPasswordManagement', () => completeEmailChange(this.deps, input)),
  }
  /**
   * Account export and deletion, for `dataExport` and `accountDeletion`. Both need the current
   * password or a recent proof.
   */
  readonly accountData = {
    /** Returns a JSON export of the account, merged with `exportAccountData`. */
    export: (input: AccountDataInput): Promise<AccountExport> =>
      this.enabled('dataExport', () => exportAccountData(this.deps, input)),
    /**
     * Deletes the user and every row Account Kit owns, runs `onAccountDeletingTransaction` first,
     * and sends the confirmation email.
     */
    delete: (input: AccountDataInput): Promise<void> =>
      this.enabled('accountDeletion', () => deleteAccount(this.deps, input)),
  }
}
