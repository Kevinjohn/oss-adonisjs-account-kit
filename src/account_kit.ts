import { pruneExpired, type PruneInput } from './maintenance.ts'
import { E_ACCOUNT_KIT_CAPABILITY_DISABLED } from './errors.ts'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import {
  inspectPasswordReset,
  requestPasswordReset,
  completePasswordReset,
} from './password_reset.ts'
import { createAuthenticationService } from './authentication.ts'
import { completeMagicLink, inspectMagicLink, requestMagicLink } from './magic_link.ts'
import { createSessionManagementService } from './session_management.ts'
import { RevocationOutcomes } from './session_revocation.ts'
import { register } from './registration.ts'
import { completeVerification, inspectVerification, sendVerification } from './verification.ts'
import {
  changePassword,
  completeEmailChange,
  inspectEmailChange,
  requestEmailChange,
  updateProfile,
} from './credentials.ts'
import { createThrottler } from './throttle.ts'
import { createManagedHttpService } from './managed_http_service.ts'
import { createSocialIdentityService } from './social_identity.ts'
import { issueStandaloneOperatorInvitation, issueOperatorResetLink } from './operator.ts'
import { ExportFaults, exportAccountData } from './account_export.ts'
import type { ServiceDependencies } from './service_dependencies.ts'
import { deleteAccount } from './account_deletion.ts'
import {
  acceptInvitation,
  inspectInvitation,
  paginateInvitations,
  resendInvitation,
  revokeInvitation,
  sendInvitation,
} from './invitations.ts'
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
} from './types.ts'

export { defineConfig } from './config.ts'

/**
 * The account service. Resolve it from the container with `app.container.make(AccountKit)`. Each
 * capability group throws `E_ACCOUNT_KIT_CAPABILITY_DISABLED` when its capability is not in `enabled`.
 * The `authentication` group depends on the `authentication` config block, except `sessions`, which
 * needs `sessionManagement`, and `retirementImpact`, which returns an empty inventory without
 * scanning accounts when no login methods are configured. `maintenance` is always available.
 *
 * @example
 * ```ts
 * import { AccountKit } from '@kevinjohn/adonisjs-account-kit'
 * import app from '@adonisjs/core/services/app'
 *
 * const kit = await app.container.make(AccountKit)
 * await kit.maintenance.prune({ batchSize: 100 })
 * ```
 */
export class AccountKit {
  readonly #deps: ServiceDependencies

  constructor(deps: { config: ResolvedConfig; db: Database; limiter: LimiterService }) {
    this.#deps = {
      config: deps.config,
      db: deps.db,
      limiter: deps.limiter,
      throttler: createThrottler({
        limiter: deps.limiter,
        secret: deps.config.limiterSecret,
        namespace: deps.config.limiterNamespace,
      }),
      exportFaults: new ExportFaults(),
      revocationOutcomes: new RevocationOutcomes(),
    }
  }

  /** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
  #runEnabledCapability<T>(capability: Capability, run: () => Promise<T>): Promise<T> {
    if (!this.#deps.config.enabled.includes(capability))
      return Promise.reject(new E_ACCOUNT_KIT_CAPABILITY_DISABLED(`${capability} is disabled`))
    return run()
  }

  /** Housekeeping for scheduled jobs. */
  readonly maintenance = {
    /**
     * Deletes expired tokens, invitations, social states and sign-ins in batches. `account-
     * kit:prune` calls it.
     *
     * @example
     * ```ts
     * await kit.maintenance.prune({ batchSize: 100 })
     * ```
     */
    prune: (input: PruneInput = {}) => pruneExpired(this.#deps.db, input),
  }

  /**
   * Shared-store, secret-keyed client budget for managed proof URL requests.
   *
   * @internal
   */
  get managedHttp() {
    return createManagedHttpService(this.#deps)
  }

  /**
   * Login, the current account, restrictions, and signed-in devices. Needs the `authentication`
   * config.
   */
  get authentication(): ReturnType<typeof createAuthenticationService> & {
    /** Where the user is signed in; requires `sessionManagement`. */
    sessions: ReturnType<typeof createSessionManagementService>
  } {
    return {
      ...createAuthenticationService(this.#deps),
      sessions: createSessionManagementService(this.#deps),
    }
  }

  /** Self-service signup, for `registration`. */
  readonly registration = {
    /**
     * Creates an account when registration availability allows it and sends the confirmation link.
     * Throws `E_ACCOUNT_KIT_REGISTRATION_EMAIL_ALREADY_REGISTERED` for a taken address.
     *
     * @example
     * ```ts
     * await kit.registration.register({ email: 'sam@example.test', password })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    register: (input: RegistrationInput): Promise<AccountUser> =>
      this.#runEnabledCapability('registration', () => register(this.#deps, input)),
  }

  /** Google and GitHub sign-in, linking and recent proof, for `socialAuthentication`. */
  get socialAuthentication(): ReturnType<typeof createSocialIdentityService> {
    if (!this.#deps.config.enabled.includes('socialAuthentication'))
      throw new E_ACCOUNT_KIT_CAPABILITY_DISABLED('Social authentication is disabled')
    return createSocialIdentityService(this.#deps)
  }

  /** Passwordless sign-in by an email link bound to the requesting client. */
  readonly magicLink = {
    /**
     * Emails a sign-in link. Answers the same way, after `minRequestMs`, whether or not the address
     * has an account.
     *
     * @example
     * ```ts
     * await kit.magicLink.request({ email: 'sam@example.test', clientKey: request.ip(), clientChallenge })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    request: (input: MagicLinkRequestInput): Promise<void> =>
      this.#runEnabledCapability('magicLinkLogin', () => requestMagicLink(this.#deps, input)),
    /**
     * Checks that the stored link exists, is unexpired, and still matches the account's email and
     * active state. This read-only check does not evaluate `canAccess` or guarantee sign-in.
     *
     * @example
     * ```ts
     * await kit.magicLink.inspect({ token })
     * ```
     */
    inspect: (input: MagicLinkInspectInput): Promise<boolean> =>
      this.#runEnabledCapability('magicLinkLogin', () => inspectMagicLink(this.#deps, input)),
    /**
     * Uses the link once and signs the user in through `guard`. The verifier must match the
     * challenge sent with the request.
     *
     * @example
     * ```ts
     * await kit.magicLink.complete({ token, verifier }, requestGuard)
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    complete: <Credential>(
      input: MagicLinkCompleteInput,
      guard: AuthenticationGuard<Credential>
    ): Promise<{ account: CurrentAccount; credential: Credential }> =>
      this.#runEnabledCapability('magicLinkLogin', () =>
        completeMagicLink(this.#deps, input, guard)
      ),
  }

  /** Forgot-password links, for `passwordReset`. */
  readonly passwordReset = {
    /**
     * Emails a reset link to a known address. Answers the same way, after `minRequestMs`, whether
     * or not the address has an account.
     *
     * @example
     * ```ts
     * await kit.passwordReset.request({ email: 'sam@example.test', clientKey: request.ip() })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    request: (input: PasswordResetRequestInput): Promise<void> =>
      this.#runEnabledCapability('passwordReset', () => requestPasswordReset(this.#deps, input)),
    /**
     * Whether a reset link is still usable, without using it up.
     *
     * @example
     * ```ts
     * await kit.passwordReset.inspect({ token })
     * ```
     */
    inspect: (input: PasswordResetInspectInput): Promise<boolean> =>
      this.#runEnabledCapability('passwordReset', () => inspectPasswordReset(this.#deps, input)),
    /**
     * Uses the link once, sets the new password, ends older sessions and tokens, and sends the
     * completed notice. Throws `E_ACCOUNT_KIT_INVALID_TOKEN` for a bad link.
     *
     * @example
     * ```ts
     * await kit.passwordReset.reset({ token, password })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    reset: (input: PasswordResetCompleteInput): Promise<AccountUser> =>
      this.#runEnabledCapability('passwordReset', () => completePasswordReset(this.#deps, input)),
  }
  /** Account activation links, for `emailVerification`. */
  readonly emailVerification = {
    /**
     * Ensures an activation link is current, or returns `already_verified`. A `sent` result
     * inside the one-minute resend cooldown reuses the link without delivering another message.
     *
     * @example
     * ```ts
     * await kit.emailVerification.send({ userId })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    send: (input: VerificationSendInput): Promise<'sent' | 'already_verified'> =>
      this.#runEnabledCapability('emailVerification', () => sendVerification(this.#deps, input)),
    /**
     * Whether an activation link is still usable, without using it up.
     *
     * @example
     * ```ts
     * await kit.emailVerification.inspect({ token })
     * ```
     */
    inspect: (input: VerificationInspectInput): Promise<boolean> =>
      this.#runEnabledCapability('emailVerification', () => inspectVerification(this.#deps, input)),
    /**
     * Uses the link once, confirms the address and sets the password.
     *
     * @example
     * ```ts
     * await kit.emailVerification.complete({ token, password })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    complete: (input: VerificationCompleteInput): Promise<'verified'> =>
      this.#runEnabledCapability('emailVerification', () =>
        completeVerification(this.#deps, input)
      ),
  }
  /** Invitations with roles, for `invitations`. */
  readonly invitations = {
    /**
     * Invites an address with a role and emails the link; checks `authorize.invite`.
     *
     * @example
     * ```ts
     * await kit.invitations.send({ actorId, email: 'sam@example.test', role: 'member' })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    send: (input: InvitationsSendInput): Promise<Invitation> =>
      this.#runEnabledCapability('invitations', () => sendInvitation(this.#deps, input)),
    /**
     * Lists pending invitations a page at a time; checks `authorize.listInvitations`.
     *
     * @example
     * ```ts
     * await kit.invitations.list({ actorId, limit: 20 })
     * ```
     */
    list: (input: InvitationsListInput): Promise<InvitationPage> =>
      this.#runEnabledCapability('invitations', () => paginateInvitations(this.#deps, input)),
    /**
     * The email and role from a valid invitation token, or null, without using the link.
     *
     * @example
     * ```ts
     * await kit.invitations.inspect({ token })
     * ```
     */
    inspect: (input: InvitationsInspectInput): Promise<Pick<Invitation, 'email' | 'role'> | null> =>
      this.#runEnabledCapability('invitations', () => inspectInvitation(this.#deps.db, input)),
    /**
     * Uses the invitation token once, creates the account and runs `onInvitationAccepted` in the
     * same transaction. It does not call an actor authorization callback.
     *
     * @example
     * ```ts
     * await kit.invitations.accept({ token, password })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    accept: (input: InvitationsAcceptInput): Promise<AccountUser> =>
      this.#runEnabledCapability('invitations', () => acceptInvitation(this.#deps, input)),
    /**
     * Replaces the invitation's link and emails it again; checks `authorize.manageInvitation` and
     * `authorize.invite` for the invitation's role.
     *
     * @example
     * ```ts
     * await kit.invitations.resend({ actorId, invitationId })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    resend: (input: InvitationsResendInput): Promise<Invitation> =>
      this.#runEnabledCapability('invitations', () => resendInvitation(this.#deps, input)),
    /**
     * Deletes a pending invitation; checks `authorize.manageInvitation`.
     *
     * @example
     * ```ts
     * await kit.invitations.revoke({ actorId, invitationId })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    revoke: (input: InvitationsRevokeInput): Promise<void> =>
      this.#runEnabledCapability('invitations', () => revokeInvitation(this.#deps, input)),
  }
  /**
   * Operator context only: callers with shell access (Ace commands). No actor authorization and no
   * throttles apply; never expose these methods to an HTTP request.
   */
  readonly operator = {
    /**
     * Send an invitation on behalf of the system, without an inviting user.
     *
     * @example
     * ```ts
     * await kit.operator.invite({ email: 'sam@example.test', role: 'member', deliver: 'send' })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    invite: (input: OperatorInviteInput): Promise<OperatorInviteResult> =>
      this.#runEnabledCapability('invitations', () =>
        issueStandaloneOperatorInvitation(this.#deps, input)
      ),
    /**
     * Issue a password reset link for an address, without the public throttle.
     *
     * @example
     * ```ts
     * await kit.operator.resetLink({ email: 'sam@example.test', deliver: 'send' })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    resetLink: (input: OperatorResetLinkInput): Promise<OperatorResetLinkResult> =>
      this.#runEnabledCapability('passwordReset', () => issueOperatorResetLink(this.#deps, input)),
  }
  /**
   * Account settings, for `emailPasswordManagement`. Changes need the current password, or a recent
   * proof for a social-only account.
   */
  readonly emailPasswordManagement = {
    /**
     * Changes the password, ends older sessions and tokens, and sends the changed notice.
     *
     * @example
     * ```ts
     * await kit.emailPasswordManagement.changePassword({ actorId, currentPassword, newPassword })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    changePassword: (input: ChangePasswordInput): Promise<{ revision: string | null }> =>
      this.#runEnabledCapability('emailPasswordManagement', () =>
        changePassword(this.#deps, input)
      ),
    /**
     * Emails a confirmation link to the new address. The email changes only when it is confirmed.
     *
     * @example
     * ```ts
     * await kit.emailPasswordManagement.requestEmailChange({ actorId, currentPassword, newEmail: 'new-address@example.test' })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    requestEmailChange: (input: RequestEmailChangeInput): Promise<void> =>
      this.#runEnabledCapability('emailPasswordManagement', () =>
        requestEmailChange(this.#deps, input)
      ),
    /**
     * Updates profile fields, and starts an email change when `email` differs.
     *
     * @example
     * ```ts
     * await kit.emailPasswordManagement.updateProfile({ actorId, currentPassword, registrationData: { displayName: 'Sam Example' } })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    updateProfile: (input: UpdateProfileInput): Promise<AccountUser> =>
      this.#runEnabledCapability('emailPasswordManagement', () => updateProfile(this.#deps, input)),
    /**
     * Whether an email-change link is still usable, without using it up.
     *
     * @example
     * ```ts
     * await kit.emailPasswordManagement.inspectEmailChange({ token })
     * ```
     */
    inspectEmailChange: (input: InspectEmailChangeInput): Promise<boolean> =>
      this.#runEnabledCapability('emailPasswordManagement', () =>
        inspectEmailChange(this.#deps, input)
      ),
    /**
     * Uses the link once, switches the address, ends older sessions and tokens, and tells the old
     * address.
     *
     * @example
     * ```ts
     * await kit.emailPasswordManagement.completeEmailChange({ token })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    completeEmailChange: (input: CompleteEmailChangeInput): Promise<AccountUser> =>
      this.#runEnabledCapability('emailPasswordManagement', () =>
        completeEmailChange(this.#deps, input)
      ),
  }
  /**
   * Account export and deletion, for `dataExport` and `accountDeletion`. Both need the current
   * password or a recent proof.
   */
  readonly accountData = {
    /**
     * Returns a JSON export of the account, merged with `exportAccountData`.
     *
     * @example
     * ```ts
     * await kit.accountData.export({ actorId, currentPassword })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    export: (input: AccountDataInput): Promise<AccountExport> =>
      this.#runEnabledCapability('dataExport', () => exportAccountData(this.#deps, input)),
    /**
     * Deletes the user and every row Account Kit owns, runs `onAccountDeletingTransaction` first,
     * and sends the confirmation email.
     *
     * @example
     * ```ts
     * await kit.accountData.delete({ actorId, currentPassword })
     * ```
     *
     * @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed.
     */
    delete: (input: AccountDataInput): Promise<void> =>
      this.#runEnabledCapability('accountDeletion', () => deleteAccount(this.#deps, input)),
  }
}
