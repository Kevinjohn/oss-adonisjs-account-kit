import type { AccountExport, CurrentAccount, InvitationPage } from '../types.js'
import type { ManagedEndpointName } from './routes.js'
import type { SensitivePurpose, SignIn, SocialProviderName } from '../types.js'

/** Default request bodies; `:token` and `:id` values are URL path parameters. */
export interface ManagedRequestBodies {
  'auth.signup': {
    email: string
    password: string
    passwordConfirmation: string
    registrationData?: Record<string, unknown>
  }
  'auth.csrf': undefined
  'auth.login': { email: string; password: string }
  'auth.passwordReset.request': { email: string }
  'auth.passwordReset.inspect': undefined
  'auth.passwordReset.complete': { password: string; passwordConfirmation: string }
  /** `clientChallenge` is required for access-token guards; session guards keep the verifier. */
  'auth.magicLink.request': { email: string; clientChallenge?: string }
  'auth.magicLink.inspect': undefined
  /** `verifier` is required for access-token guards; session guards read it from the session. */
  'auth.magicLink.complete': { verifier?: string }
  'auth.emailVerification.inspect': undefined
  'auth.emailVerification.complete': { password: string; passwordConfirmation: string }
  'auth.invitation.inspect': undefined
  'auth.invitation.accept': {
    password: string
    passwordConfirmation: string
    registrationData?: Record<string, unknown>
  }
  'auth.emailChange.inspect': undefined
  'auth.emailChange.complete': undefined
  'account.logout': undefined
  'account.profile.show': undefined
  'account.profile.update': {
    currentPassword?: string
    recentProof?: string
    email?: string
    registrationData?: Record<string, unknown>
  }
  'account.password.change': {
    currentPassword?: string
    recentProof?: string
    newPassword: string
    newPasswordConfirmation: string
  }
  'account.emailVerification.send': undefined
  'account.invitation.send': { email: string; role: string }
  'account.invitation.list': undefined
  'account.invitation.resend': undefined
  'account.invitation.revoke': undefined
  'auth.oauth.redirect': {
    intent?: 'login' | 'link' | 'reauth'
    purpose?: SensitivePurpose
    proof?: string
    clientChallenge?: string
  }
  'auth.oauth.callback': undefined
  'auth.oauth.complete': {
    code: string
    state: string
    intent?: 'login' | 'link' | 'reauth' | 'confirm'
  }
  'auth.oauth.registration': { continuation: string; email?: string; registrationData?: unknown }
  'auth.oauth.confirmation': { verificationToken: string; clientChallenge?: string }
  'auth.oauth.token': { code: string; verifier: string }
  'auth.methods': undefined
  'account.socialProof.password': {
    password: string
    purpose: SensitivePurpose
  }
  'account.socialIdentities.list': undefined
  'account.socialIdentities.unlink': { proof: string }
  'account.sessions.list': undefined
  'account.sessions.revoke': undefined
  'account.sessions.revokeOthers': undefined
  'account.sessions.revokeAll': undefined
  'account.data.export': { currentPassword?: string; recentProof?: string }
  'account.delete': { currentPassword?: string; recentProof?: string }
}

export type ManagedRequestBody<Name extends ManagedEndpointName> = ManagedRequestBodies[Name]

/** Query parameters are separate from JSON request bodies. */
export interface ManagedQueries {
  'auth.signup': undefined
  'auth.csrf': undefined
  'auth.login': undefined
  'auth.passwordReset.request': undefined
  'auth.passwordReset.inspect': undefined
  'auth.passwordReset.complete': undefined
  'auth.magicLink.request': undefined
  'auth.magicLink.inspect': undefined
  'auth.magicLink.complete': undefined
  'auth.emailVerification.inspect': undefined
  'auth.emailVerification.complete': undefined
  'auth.invitation.inspect': undefined
  'auth.invitation.accept': undefined
  'auth.emailChange.inspect': undefined
  'auth.emailChange.complete': undefined
  'auth.oauth.redirect': undefined
  'auth.oauth.callback':
    | { code: string; state: string; error?: never }
    | { error: string; state?: string; code?: string }
  'auth.oauth.complete': undefined
  'auth.oauth.registration': undefined
  'auth.oauth.confirmation': undefined
  'auth.oauth.token': undefined
  'auth.methods': undefined
  'account.logout': undefined
  'account.profile.show': undefined
  'account.profile.update': undefined
  'account.password.change': undefined
  'account.emailVerification.send': undefined
  'account.invitation.send': undefined
  'account.invitation.list': { limit?: number; cursor?: string }
  'account.invitation.resend': undefined
  'account.invitation.revoke': undefined
  'account.socialProof.password': undefined
  'account.socialIdentities.list': undefined
  'account.socialIdentities.unlink': undefined
  'account.sessions.list': undefined
  'account.sessions.revoke': undefined
  'account.sessions.revokeOthers': undefined
  'account.sessions.revokeAll': undefined
  'account.data.export': undefined
  'account.delete': undefined
}

export type ManagedQuery<Name extends ManagedEndpointName> = ManagedQueries[Name]

/** A write committed, but a post-commit callback or delivery failed. */
export interface ManagedCommittedSuccess {
  committed: true
}

export type ManagedSocialFlowBody =
  | ManagedCommittedSuccess
  | { status: 'linked' | 'new'; account: CurrentAccount }
  | { status: 'linked' | 'new'; code: string }
  | { status: 'linked' | 'new' }
  | { status: 'new'; continuation: string }
  | { status: 'new'; emailVerificationRequired: true }
  | { status: 'link_required' }
  | { status: 'reauthenticated'; proof: string }

/** Base response bodies before application-owned account representation is added. */
export interface ManagedSuccessBodies {
  'auth.signup':
    { account: CurrentAccount; token?: string } | { registered: true; authenticated: false }
  'auth.csrf': { csrfToken: string }
  'auth.login': { account: CurrentAccount; token?: string }
  'auth.passwordReset.request': { message: string }
  'auth.passwordReset.inspect': { valid: true }
  'auth.passwordReset.complete': { reset: true } | ManagedCommittedSuccess
  'auth.magicLink.request': { message: string }
  'auth.magicLink.inspect': { valid: true }
  'auth.magicLink.complete': { account: CurrentAccount; token?: string }
  'auth.emailVerification.inspect': { valid: true }
  'auth.emailVerification.complete': { verified: true } | ManagedCommittedSuccess
  'auth.invitation.inspect': { email: string; role: string }
  'auth.invitation.accept': { account: CurrentAccount } | ManagedCommittedSuccess
  'auth.emailChange.inspect': { valid: true }
  'auth.emailChange.complete': { account: CurrentAccount } | ManagedCommittedSuccess
  'account.logout': undefined
  'account.profile.show': { account: CurrentAccount }
  'account.profile.update': { account: CurrentAccount } | ManagedCommittedSuccess
  'account.password.change': { changed: true } | ManagedCommittedSuccess
  'account.emailVerification.send':
    { result: 'sent' | 'already_verified' } | ManagedCommittedSuccess
  'account.invitation.send': { id: number } | ManagedCommittedSuccess
  'account.invitation.list': InvitationPage
  'account.invitation.resend': { id: number } | ManagedCommittedSuccess
  'account.invitation.revoke': undefined | ManagedCommittedSuccess
  'auth.oauth.redirect': { authorizationUrl: string }
  'auth.oauth.callback': ManagedSocialFlowBody
  'auth.oauth.complete': ManagedSocialFlowBody
  'auth.oauth.registration': ManagedSocialFlowBody
  'auth.oauth.confirmation': { authorizationUrl: string }
  'auth.oauth.token': { account: CurrentAccount; token: string }
  'auth.methods': {
    providers: readonly SocialProviderName[]
    lastUsedMethod: 'password' | SocialProviderName | null
  }
  'account.socialProof.password': { proof: string }
  'account.socialIdentities.list': {
    identities: Array<{
      id: number
      provider: SocialProviderName
      email: string | null
      emailVerified: boolean
    }>
  }
  'account.socialIdentities.unlink': undefined | ManagedCommittedSuccess
  'account.sessions.list': { sessions: SignIn[] }
  'account.sessions.revoke': undefined | ManagedCommittedSuccess
  'account.sessions.revokeOthers': { count: number } | ManagedCommittedSuccess
  'account.sessions.revokeAll': undefined | ManagedCommittedSuccess
  'account.data.export': AccountExport
  'account.delete': undefined | ManagedCommittedSuccess
}

export type ManagedSuccessBody<Name extends ManagedEndpointName> = ManagedSuccessBodies[Name]

type CompleteInventory =
  Exclude<ManagedEndpointName, keyof ManagedSuccessBodies> extends never
    ? Exclude<keyof ManagedSuccessBodies, ManagedEndpointName> extends never
      ? Exclude<ManagedEndpointName, keyof ManagedRequestBodies> extends never
        ? Exclude<keyof ManagedRequestBodies, ManagedEndpointName> extends never
          ? Exclude<ManagedEndpointName, keyof ManagedQueries> extends never
            ? Exclude<keyof ManagedQueries, ManagedEndpointName> extends never
              ? true
              : never
            : never
          : never
        : never
      : never
    : never

export const managedSuccessContractComplete: CompleteInventory = true

export interface ManagedErrorBody {
  errors: Array<{ code: string; message: string; field?: string } | { code: string; title: string }>
}
