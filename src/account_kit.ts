import { DateTime } from 'luxon'
import string from '@adonisjs/core/helpers/string'
import type { Encryption } from '@adonisjs/core/encryption'
import type { Database } from '@adonisjs/lucid/database'
import type { LimiterService } from '@adonisjs/limiter/types'
import { expiresAt } from './ttl.js'
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

const MAX_LIMITER_DURATION_MS = 2_147_483_647

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
  if (
    config.onCredentialsChanged !== undefined &&
    typeof config.onCredentialsChanged !== 'function'
  ) {
    throw new Error('account_kit: onCredentialsChanged must be a function when supplied')
  }
  const ttl = {
    recovery: config.ttl?.recovery ?? '1h',
    verification: config.ttl?.verification ?? '1h',
    invitation: config.ttl?.invitation ?? '7d',
    emailChange: config.ttl?.emailChange ?? '1h',
  }
  for (const value of Object.values(ttl)) expiresAt(DateTime.utc(), value)
  const throttle = {
    requests: config.throttle?.requests ?? 5,
    duration: config.throttle?.duration ?? '15m',
  }
  if (!Number.isSafeInteger(throttle.requests) || throttle.requests <= 0) {
    throw new Error('account_kit: throttle.requests must be a positive safe integer')
  }
  let durationMs: number
  try {
    durationMs = string.seconds.parse(throttle.duration) * 1000
  } catch (cause) {
    throw new Error('account_kit: throttle.duration must be a supported positive duration', {
      cause,
    })
  }
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs > MAX_LIMITER_DURATION_MS
  ) {
    throw new Error('account_kit: throttle.duration must be a limiter-representable duration')
  }
  const minRequestMs = config.minRequestMs ?? 300
  if (!Number.isFinite(minRequestMs) || minRequestMs < 0) {
    throw new Error('account_kit: minRequestMs must be a finite non-negative number')
  }
  const usersTable = config.usersTable ?? 'users'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(usersTable)) {
    throw new Error('account_kit: usersTable must be a plain SQL identifier')
  }
  return { ...config, ttl, throttle, minRequestMs, usersTable }
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
    send: (input: VerificationSendInput): Promise<'sent' | 'already_verified'> =>
      sendVerification(this.deps, input),
    complete: (input: VerificationCompleteInput): Promise<'verified' | 'already_verified'> =>
      completeVerification(this.deps, input),
  }
  readonly invitations = {
    send: (input: InvitationsSendInput): Promise<Invitation> => sendInvitation(this.deps, input),
    list: (input: InvitationsListInput): Promise<Invitation[]> => listInvitations(this.deps, input),
    inspect: (input: InvitationsInspectInput): Promise<Pick<Invitation, 'email' | 'role'> | null> =>
      inspectInvitation(this.deps.db, input),
    accept: (input: InvitationsAcceptInput): Promise<AccountUser> =>
      acceptInvitation(this.deps, input),
    resend: (input: InvitationsResendInput): Promise<Invitation> =>
      resendInvitation(this.deps, input),
    revoke: (input: InvitationsRevokeInput): Promise<void> => revokeInvitation(this.deps, input),
  }
  readonly credentials = {
    changePassword: (input: CredentialsChangePasswordInput): Promise<void> =>
      changePassword(this.deps, input),
    requestEmailChange: (input: CredentialsRequestEmailChangeInput): Promise<void> =>
      requestEmailChange(this.deps, input),
    completeEmailChange: (input: CredentialsCompleteEmailChangeInput): Promise<AccountUser> =>
      completeEmailChange(this.deps, input),
  }
}
