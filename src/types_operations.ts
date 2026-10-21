import type { UserId, AccountUser, Invitation } from './types.js'

/**
 * Input for `registration.register`. `registrationData` is untrusted and goes through
 * `registration.mapFields`.
 */
export interface RegistrationInput {
  email: string
  password: string
  /** Untrusted extra fields, passed to `registration.mapFields`. */
  registrationData?: unknown
}

/** How an operator command delivers its link: `send` emails it, `print` returns it. */
export type OperatorDelivery = 'send' | 'print'

/** Input for `operator.invite`. */
export interface OperatorInviteInput {
  email: string
  /** The role to grant on acceptance. */
  role: string
  /** `send` notifies the invitee; `print` returns the acceptance URL instead. */
  deliver: OperatorDelivery
}

/** Input for `operator.resetLink`. */
export interface OperatorResetLinkInput {
  email: string
  /** `send` emails the link; `print` returns it. */
  deliver: OperatorDelivery
}

/** A committed follow-up failure, reduced to safe fields: no cause, stack, or URL. */
export interface OperatorFault {
  name: string
  message: string
}

/** The invitation, its URL when printed, and any follow-up failure after commit. */
export interface OperatorInviteResult {
  invitation: Invitation
  /** The acceptance link, when `deliver` was `print`. */
  url?: string
  /** A failure after the invitation was saved, such as a failed email. */
  fault?: OperatorFault
}

/** The user, the reset URL when printed, and any follow-up failure after commit. */
export interface OperatorResetLinkResult {
  user: AccountUser
  /** The reset link, when `deliver` was `print`. */
  url?: string
  /** A failure after the link was saved, such as a failed email. */
  fault?: OperatorFault
}

/**
 * One page of invitations. Pass `nextCursor` as `cursor` for the next page; null means there are no
 * more.
 */
export interface InvitationPage {
  items: Invitation[]
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null
}

/**
 * Input for `passwordReset.request`. `clientKey` is a trusted client identity such as the request
 * IP.
 */
export interface PasswordResetRequestInput {
  /** The address the user typed. */
  email: string
  /**
   * A trusted client identity for rate limits, normally `request.ip()` behind configured trusted
   * proxies.
   */
  clientKey: string
}

/** Input for `passwordReset.inspect`. */
export interface PasswordResetInspectInput {
  /** The proof token from the link. */
  token: string
}

/** Input for `passwordReset.reset`. */
export interface PasswordResetCompleteInput {
  /** The proof token from the link. */
  token: string
  /** The new password. Checked against `passwordPolicy`. */
  password: string
}

/** Input for `magicLink.request`. */
export interface MagicLinkRequestInput {
  /** The address the user typed. */
  email: string
  /** A trusted client identity for rate limits, normally `request.ip()`. */
  clientKey: string
  /** Base64url SHA-256 of a verifier the requesting client keeps; 43 characters. */
  clientChallenge: string
}

/** Input for `magicLink.inspect`. */
export interface MagicLinkInspectInput {
  /** The proof token from the link. */
  token: string
}

/** Input for `magicLink.complete`. */
export interface MagicLinkCompleteInput {
  /** The proof token from the link. */
  token: string
  /** The verifier whose challenge was sent with the request. */
  verifier: string
}

/** Input for `emailVerification.send`. */
export interface VerificationSendInput {
  /** The account to send a new activation link to. */
  userId: UserId
}

/** Input for `emailVerification.inspect`. */
export interface VerificationInspectInput {
  /** The proof token from the link. */
  token: string
}

/** Input for `emailVerification.complete`. Activation sets a fresh password. */
export interface VerificationCompleteInput {
  /** The proof token from the link. */
  token: string
  /** The password to set on activation. Checked against `passwordPolicy`. */
  password: string
}

/** Input for `invitations.send`. */
export interface InvitationsSendInput {
  /** The signed-in user sending the invitation. */
  actorId: UserId
  /** The address to invite. */
  email: string
  /** The role to grant on acceptance. */
  role: string
}

/** Input for `invitations.list`. `limit` defaults to 25, at most 100. */
export interface InvitationsListInput {
  /** The signed-in user listing invitations. */
  actorId: UserId
  /** Page size. Default 25, at most 100. */
  limit?: number
  /** `nextCursor` from the previous page. */
  cursor?: string
}

/** Input for `invitations.inspect`. */
export interface InvitationsInspectInput {
  /** The proof token from the link. */
  token: string
}

/** Input for `invitations.accept`. */
export interface InvitationsAcceptInput {
  /** The proof token from the link. */
  token: string
  /** The new account's password. Checked against `passwordPolicy`. */
  password: string
  /** Untrusted extra fields, passed to `registration.mapFields`. */
  registrationData?: unknown
}

/** Input for `invitations.resend`. */
export interface InvitationsResendInput {
  /** The signed-in user resending. */
  actorId: UserId
  /** The invitation to resend. */
  invitationId: number
}

/** Input for `invitations.revoke`. */
export interface InvitationsRevokeInput {
  /** The signed-in user revoking. */
  actorId: UserId
  /** The invitation to revoke. */
  invitationId: number
}

/**
 * Input for `emailPasswordManagement.changePassword`. Give `currentPassword`, or `recentProof` for
 * a social-only account.
 */
export interface ChangePasswordInput {
  /** The signed-in user. */
  actorId: UserId
  /** The user's current password. */
  currentPassword?: string
  /** Purpose-bound proof issued by a fresh provider reauthentication for social-only accounts. */
  recentProof?: string
  /** The new password. Checked against `passwordPolicy`. */
  newPassword: string
  /**
   * The caller's own sign-in, from `authentication.current` input, to keep while every other one
   * ends. A handle or id that matches nothing ends every sign-in.
   */
  keepCurrent?: { sessionHandle?: string; tokenId?: UserId }
}

/**
 * Input for `emailPasswordManagement.requestEmailChange`. Give `currentPassword`, or `recentProof`
 * for a social-only account.
 */
export interface RequestEmailChangeInput {
  /** The signed-in user. */
  actorId: UserId
  /** The user's current password. */
  currentPassword?: string
  /** A purpose-bound proof, for a social-only account. */
  recentProof?: string
  /** The address to switch to once confirmed. */
  newEmail: string
}

/**
 * Input for `emailPasswordManagement.updateProfile`. An email change needs `currentPassword` or
 * `recentProof`.
 */
export interface UpdateProfileInput {
  /** The signed-in user. */
  actorId: UserId
  /** The user's current password. Required when `email` changes. */
  currentPassword?: string
  /** A purpose-bound proof, for a social-only account. */
  recentProof?: string
  /** A new address; starts an email change when it differs. */
  email?: string
  /** Untrusted extra fields, passed to `registration.mapFields`. */
  registrationData?: unknown
}

/** Input for `emailPasswordManagement.completeEmailChange`. */
export interface CompleteEmailChangeInput {
  /** The proof token from the link. */
  token: string
}

/** Input for `emailPasswordManagement.inspectEmailChange`. */
export interface InspectEmailChangeInput {
  /** The proof token from the link. */
  token: string
}

/** Fresh re-authentication for export and deletion, as for a password change. */
export interface AccountDataInput {
  /** The signed-in user. */
  actorId: UserId
  /** The user's current password. */
  currentPassword?: string
  /** Purpose-bound proof (`account_export` or `account_delete`) for password-less accounts. */
  recentProof?: string
}

/** Version 1 of the account export document. Timestamps are ISO 8601 UTC strings. */
export interface AccountExport {
  format: 'adonisjs-account-kit/export'
  version: 1
  generatedAt: string
  account: {
    id: UserId
    email: string
    unverifiedEmail: string | null
    emailVerifiedAt: string | null
    hasPassword: boolean
    credentialsChangedAt: string | null
  }
  socialIdentities: Array<{
    provider: string
    providerUserId: string
    email: string | null
    emailVerified: boolean
    name: string | null
    nickname: string | null
    avatarUrl: string | null
    confirmedAt: string | null
    createdAt: string
  }>
  invitationsSent: Array<{ email: string; role: string; createdAt: string; expiresAt: string }>
  /** Present only for the access-token strategy. */
  accessTokens?: Array<{
    id: number | string
    name: string | null
    createdAt: string | null
    lastUsedAt: string | null
    expiresAt: string | null
  }>
  pending: { passwordReset: boolean; emailVerification: boolean; emailChange: string | null }
  application: unknown
}
