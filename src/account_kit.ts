import { DateTime } from 'luxon'
import type { Encryption } from '@adonisjs/core/encryption'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { expiresAt } from './ttl.js'
import { inspectRecovery, requestRecovery, resetRecovery } from './recovery.js'
import type {
  AccountKitConfig,
  AccountUser,
  CredentialsChangePasswordInput,
  CredentialsCompleteEmailChangeInput,
  CredentialsRequestEmailChangeInput,
  Invitation,
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

export function defineConfig(config: AccountKitConfig): ResolvedConfig {
  const required: Array<[string, unknown]> = [
    ['users.findByEmail', config?.users?.findByEmail],
    ['users.findById', config?.users?.findById],
    ['users.create', config?.users?.create],
    ['users.setPassword', config?.users?.setPassword],
    ['users.setEmail', config?.users?.setEmail],
    ['users.markEmailVerified', config?.users?.markEmailVerified],
    ['users.verifyPassword', config?.users?.verifyPassword],
    ['authorize.invite', config?.authorize?.invite],
    ['authorize.manageInvitation', config?.authorize?.manageInvitation],
    ['authorize.listInvitations', config?.authorize?.listInvitations],
    ['urls.recovery', config?.urls?.recovery],
    ['urls.verification', config?.urls?.verification],
    ['urls.invitation', config?.urls?.invitation],
    ['urls.emailChange', config?.urls?.emailChange],
    ['notify.recovery', config?.notify?.recovery],
    ['notify.verification', config?.notify?.verification],
    ['notify.invitation', config?.notify?.invitation],
    ['notify.emailChangeConfirm', config?.notify?.emailChangeConfirm],
    ['notify.emailChanged', config?.notify?.emailChanged],
    ['onInvitationAccepted', config?.onInvitationAccepted],
  ]
  for (const [name, callback] of required) {
    if (typeof callback !== 'function') throw new Error(`account_kit: ${name} must be a function`)
  }
  const ttl = {
    recovery: config.ttl?.recovery ?? '1h',
    verification: config.ttl?.verification ?? '1h',
    invitation: config.ttl?.invitation ?? '7d',
    emailChange: config.ttl?.emailChange ?? '1h',
  }
  for (const value of Object.values(ttl)) expiresAt(DateTime.utc(), value)
  return {
    ...config,
    ttl,
    throttle: {
      requests: config.throttle?.requests ?? 5,
      duration: config.throttle?.duration ?? '15m',
    },
    minRequestMs: config.minRequestMs ?? 300,
  }
}

function notImplemented(): never {
  throw new Error('not implemented')
}

export class AccountKit {
  constructor(
    private readonly deps: {
      config: ResolvedConfig
      db: Database
      encryption: Encryption
      limiter: LimiterService
    }
  ) {}

  readonly recovery = {
    request: (input: RecoveryRequestInput): Promise<void> => requestRecovery(this.deps, input),
    inspect: (input: RecoveryInspectInput): Promise<boolean> =>
      inspectRecovery(this.deps.db, input),
    reset: (input: RecoveryResetInput): Promise<AccountUser> => resetRecovery(this.deps, input),
  }
  readonly verification = {
    send: async (_input: VerificationSendInput): Promise<'sent' | 'already_verified'> =>
      notImplemented(),
    complete: async (_input: VerificationCompleteInput): Promise<'verified' | 'already_verified'> =>
      notImplemented(),
  }
  readonly invitations = {
    send: async (_input: InvitationsSendInput): Promise<Invitation> => notImplemented(),
    list: async (_input: InvitationsListInput): Promise<Invitation[]> => notImplemented(),
    inspect: async (
      _input: InvitationsInspectInput
    ): Promise<Pick<Invitation, 'email' | 'role'> | null> => notImplemented(),
    accept: async (_input: InvitationsAcceptInput): Promise<AccountUser> => notImplemented(),
    resend: async (_input: InvitationsResendInput): Promise<Invitation> => notImplemented(),
    revoke: async (_input: InvitationsRevokeInput): Promise<void> => notImplemented(),
  }
  readonly credentials = {
    changePassword: async (_input: CredentialsChangePasswordInput): Promise<void> =>
      notImplemented(),
    requestEmailChange: async (_input: CredentialsRequestEmailChangeInput): Promise<void> =>
      notImplemented(),
    completeEmailChange: async (
      _input: CredentialsCompleteEmailChangeInput
    ): Promise<AccountUser> => notImplemented(),
  }
}
