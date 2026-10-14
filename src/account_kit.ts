import { pruneExpired, type PruneInput } from './maintenance.js'
import { CapabilityDisabledError } from './errors.js'
import type { Encryption } from '@adonisjs/core/encryption'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { inspectRecovery, requestRecovery, resetRecovery } from './recovery.js'
import { completeVerification, sendVerification } from './verification.js'
import { changePassword, completeEmailChange, requestEmailChange } from './credentials.js'
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
  CredentialsChangePasswordInput,
  CredentialsCompleteEmailChangeInput,
  CredentialsRequestEmailChangeInput,
  Invitation,
  InvitationPage,
  Capability,
  InvitationsAcceptInput,
  InvitationsInspectInput,
  InvitationsListInput,
  InvitationsResendInput,
  InvitationsRevokeInput,
  InvitationsSendInput,
  RecoveryInspectInput,
  RecoveryRequestInput,
  RecoveryResetInput,
  ResolvedConfig,
  VerificationCompleteInput,
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

  readonly recovery = {
    request: (input: RecoveryRequestInput): Promise<void> =>
      this.enabled('recovery', () => requestRecovery(this.deps, input)),
    inspect: (input: RecoveryInspectInput): Promise<boolean> =>
      this.enabled('recovery', () => inspectRecovery(this.deps.db, input)),
    reset: (input: RecoveryResetInput): Promise<AccountUser> =>
      this.enabled('recovery', () => resetRecovery(this.deps, input)),
  }
  readonly verification = {
    send: (input: VerificationSendInput): Promise<'sent' | 'already_verified'> =>
      this.enabled('verification', () => sendVerification(this.deps, input)),
    complete: (input: VerificationCompleteInput): Promise<'verified' | 'already_verified'> =>
      this.enabled('verification', () => completeVerification(this.deps, input)),
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
  readonly credentials = {
    changePassword: (input: CredentialsChangePasswordInput): Promise<void> =>
      this.enabled('credentials', () => changePassword(this.deps, input)),
    requestEmailChange: (input: CredentialsRequestEmailChangeInput): Promise<void> =>
      this.enabled('credentials', () => requestEmailChange(this.deps, input)),
    completeEmailChange: (input: CredentialsCompleteEmailChangeInput): Promise<AccountUser> =>
      this.enabled('credentials', () => completeEmailChange(this.deps, input)),
  }
}
