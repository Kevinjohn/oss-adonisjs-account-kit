import type { DateTime } from 'luxon'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { SocialIdentity } from './types.js'

/**
 * A Lucid transaction. Account Kit passes it to every callback that runs inside an account
 * operation; do all database writes in that callback through it.
 */
export type Trx = TransactionClientContract

/** A user's primary key: an integer, string or UUID. */
export type UserId = number | string

/** The account fields Account Kit reads from your users table. */
export interface AccountUser {
  /** The user's primary key. */
  id: UserId
  /** The confirmed address, stored trimmed and lowercase. */
  email: string
  /** An address waiting for confirmation, or null. */
  unverifiedEmail: string | null
  /** False for an account that signs in only through a social provider. */
  hasPassword: boolean
  /** When the address was confirmed; null for an account that has not confirmed it. */
  emailVerifiedAt: DateTime | null
}

/**
 * Where the users live: the physical table, the `id` primary key and, optionally, the unique email
 * constraint name.
 */
export interface UsersAdapterMetadata {
  /** The physical users table. */
  table: string
  /** Always `id`. */
  primaryKey: 'id'
  /** The unique email constraint name, when it is not the default. */
  emailConstraint?: string
}

/**
 * Passed to `authorize` callbacks. `trx` is set when the check runs inside an account transaction;
 * read permission state through it.
 */
export interface AuthorizationContext {
  /** The account transaction, when the check runs inside one. */
  trx?: Trx
}

/**
 * Custom adapters normalize stored email and enforce a single-column unique email index.
 * Configure physical table/constraint metadata, use the default connection, hash passwords,
 * and run every method receiving trx through that transaction. The package owns physical
 * row locks; legacy forUpdate arguments remain additive compatibility parameters.
 * The maintained Lucid adapter derives metadata and preserves model save hooks.
 */
export interface UsersAdapter {
  /**
   * Returns the table and constraint metadata. Omit it to use `usersTable` and `emailConstraint`
   * from the config.
   */
  resolveMetadata?(): Promise<UsersAdapterMetadata>
  /** Finds a user by normalized email, or returns null. */
  findByEmail(
    email: string,
    trx?: Trx,
    options?: { forUpdate?: boolean }
  ): Promise<AccountUser | null>
  /** Finds a user by id, or returns null. */
  findById(id: UserId, trx?: Trx, options?: { forUpdate?: boolean }): Promise<AccountUser | null>
  /**
   * Creates a user through `trx` and returns it. `registrationData` is untrusted input for your own
   * mapping.
   */
  create(
    attrs: {
      email: string
      unverifiedEmail: string | null
      /** The plain password to hash, or null. Null whenever `passwordHash` is set. */
      password: string | null
      /** A hash from `hashPassword`, to store as is. Only passed when `hashPassword` exists. */
      passwordHash?: string
      registrationData?: unknown
    },
    trx: Trx
  ): Promise<AccountUser>
  /** Hashes and stores a new password through `trx`. */
  setPassword(id: UserId, password: string, trx: Trx): Promise<void>
  /**
   * Hashes a password outside any transaction. When present, Account Kit hashes every new
   * password before it opens the write transaction and passes the result to `create` as
   * `passwordHash` or to `setPasswordHash`, so a slow hash never holds the transaction open.
   * Requires `setPasswordHash`.
   */
  hashPassword?(password: string): Promise<string>
  /** Stores a hash from `hashPassword` as is, through `trx`. Required with `hashPassword`. */
  setPasswordHash?(id: UserId, hash: string, trx: Trx): Promise<void>
  /** Stores a confirmed email address through `trx`. */
  setEmail(id: UserId, email: string, trx: Trx): Promise<void>
  /** Stores or clears the address waiting for confirmation, through `trx`. */
  setUnverifiedEmail(id: UserId, email: string | null, trx: Trx): Promise<void>
  /** Applies trusted profile fields through `trx`. Needed for profile updates with extra fields. */
  updateRegistrationData?(id: UserId, data: Record<string, unknown>, trx: Trx): Promise<void>
  /** Records when the address was confirmed, through `trx`. */
  markEmailVerified(id: UserId, at: DateTime, trx: Trx): Promise<void>
  /** Returns whether the password matches the stored hash. */
  verifyPassword(id: UserId, password: string, trx: Trx): Promise<boolean>
  /** Required by `accountDeletion`. Delete the user row through trx; model hooks may run. */
  delete?(id: UserId, trx: Trx): Promise<void>
}

/** A pending invitation. `role` is an opaque string your `onInvitationAccepted` callback applies. */
export interface Invitation {
  /** The invitation's id, for `resend` and `revoke`. */
  id: number
  /** The invited address, normalized. */
  email: string
  /**
   * The role to grant on acceptance. Account Kit stores it; your `onInvitationAccepted` applies it.
   */
  role: string
  /** Who sent it, or null for an operator invitation or a deleted inviter. */
  inviterId: UserId | null
  /** When the link stops working. */
  expiresAt: DateTime
  createdAt: DateTime
  updatedAt: DateTime
}

/**
 * A feature you can turn on in `enabled`. Operations for a capability that is not enabled throw
 * `CapabilityDisabledError`.
 */
export type Capability =
  | 'passwordReset'
  | 'emailVerification'
  | 'invitations'
  | 'emailPasswordManagement'
  | 'registration'
  | 'socialAuthentication'
  | 'magicLinkLogin'
  | 'sessionManagement'
  | 'dataExport'
  | 'accountDeletion'

/** The kind of credential change that ended older sessions and tokens. */
export type CredentialOperation =
  | 'password_reset'
  | 'password_change'
  | 'email_change'
  | 'access_restriction'
  | 'registration_claim'
  | 'social_unlink'
  | 'sign_out_everywhere'

/**
 * Describes a credential change: what happened, a unique id for the operation, and whose account it
 * was.
 */
export interface CredentialChangeContext {
  /** What changed the credentials. */
  operation: CredentialOperation
  /** A unique id for this change, for idempotent workers and audit logs. */
  operationId: string
  /** Whose credentials changed. */
  userId: UserId
}

/**
 * An account event passed to `onLifecycleEvent` after commit, for audit logs and analytics. Carries
 * ids only, never tokens or addresses.
 */
export type LifecycleEvent =
  | {
      type:
        | 'registration.created'
        | 'verification.completed'
        | 'password_reset.requested'
        | 'password.reset'
        | 'password.changed'
        | 'email_change.requested'
        | 'email_change.completed'
        | 'magic_link.requested'
        | 'sessions.revoked_all'
        | 'account.deleted'
      userId: UserId
      operationId: string
      /** Present only when an operator command, not an account holder, started the operation. */
      source?: 'operator'
    }
  | { type: 'sessions.revoked'; userId: UserId; operationId: string; count: number }
  | {
      type: 'invitation.sent' | 'invitation.resent' | 'invitation.revoked'
      invitationId: number
      operationId: string
      source?: 'operator'
    }
  | { type: 'invitation.accepted'; invitationId: number; userId: UserId; operationId: string }

/** Your rules for invitations. Each callback must return exactly `true` to allow. */
export interface AuthorizationCallbacks {
  /** Whether `actor` may invite someone with `role`. */
  invite(actor: AccountUser, role: string, context?: AuthorizationContext): Promise<boolean>
  /** Whether `actor` may resend or revoke this invitation. */
  manageInvitation(
    actor: AccountUser,
    invitation: Invitation,
    context?: AuthorizationContext
  ): Promise<boolean>
  /** Whether `actor` may list invitations. */
  listInvitations(actor: AccountUser, context?: AuthorizationContext): Promise<boolean>
}

/**
 * Build the links that go in emails. Each receives the proof token and returns an absolute URL,
 * normally to a page on your frontend.
 */
export interface UrlCallbacks {
  /** The reset-password page. */
  passwordReset(token: string): string
  /** The confirm-email page. */
  emailVerification(token: string): string
  /** The accept-invitation page. */
  invitation(token: string): string
  /** The confirm-new-email page. */
  emailChange(token: string): string
  /** The magic-link sign-in page. */
  magicLink(token: string): string
}

/**
 * Send account emails. Provision callbacks receive a link to deliver; notice callbacks tell the
 * user something changed. `createMailNotifications` implements all of them with AdonisJS Mail.
 */
export interface NotificationCallbacks {
  /** Send the reset link. */
  passwordResetProvision(user: AccountUser, url: string): Promise<void>
  /** Send the link that confirms a new account's address. */
  accountActivationProvision(user: AccountUser, url: string): Promise<void>
  /** Send the invitation link. */
  invitationProvision(invitation: Invitation, url: string): Promise<void>
  /** Send the confirmation link to the new address. */
  emailChangeProvision(user: AccountUser, newEmail: string, url: string): Promise<void>
  /** Tell the previous address that the email changed. */
  emailChanged(previousEmail: string, user: AccountUser): Promise<void>
  /** Tell the user their password was reset. */
  passwordResetCompleted(user: AccountUser, context: CredentialChangeContext): Promise<void>
  /** Tell the user their password was changed. */
  passwordChanged(user: AccountUser, context: CredentialChangeContext): Promise<void>
  /** Tell the user a provider was linked. Sent only to a confirmed address. */
  socialIdentityLinked(user: AccountUser, identity: SocialIdentity): Promise<void>
  /** Tell the user a provider was unlinked. Sent only to a confirmed address. */
  socialIdentityUnlinked(user: AccountUser, identity: SocialIdentity): Promise<void>
  /** Send the magic sign-in link. */
  magicLinkProvision(user: AccountUser, url: string): Promise<void>
  /** Sent after commit to the address the deleted account had. */
  accountDeleted(account: DeletedAccount): Promise<void>
}

/** What remains of a deleted account: enough to address the confirmation email. */
export interface DeletedAccount {
  id: UserId
  email: string
}

/** A rate limit: `requests` allowed per `duration`, such as `'15m'`. */
export interface ThrottleBudget {
  /** Requests allowed in each window. */
  requests: number
  /** The window, as a duration string such as `'15m'`. */
  duration: string
}

/**
 * Invitation rate limits. Defaults: 10 sends per actor and 3 per recipient per hour, 10 resends per
 * actor and 3 per invitation per hour.
 */
export interface InvitationThrottle {
  /** Invitations one person may send. Default 10 per hour. */
  sendActor: ThrottleBudget
  /** Invitations one address may receive. Default 3 per hour. */
  sendRecipient: ThrottleBudget
  /** Resends one person may make. Default 10 per hour. */
  resendActor: ThrottleBudget
  /** Resends of one invitation. Default 3 per hour. */
  resendInvitation: ThrottleBudget
}
