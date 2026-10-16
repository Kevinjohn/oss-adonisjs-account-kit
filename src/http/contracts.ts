import type { CurrentAccount, InvitationPage } from '../types.js'
import type { ManagedEndpointName } from './routes.js'

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
    currentPassword: string
    email?: string
    registrationData?: Record<string, unknown>
  }
  'account.password.change': {
    currentPassword: string
    newPassword: string
    newPasswordConfirmation: string
  }
  'account.emailVerification.send': undefined
  'account.invitation.send': { email: string; role: string }
  'account.invitation.list': undefined
  'account.invitation.resend': undefined
  'account.invitation.revoke': undefined
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
  'auth.emailVerification.inspect': undefined
  'auth.emailVerification.complete': undefined
  'auth.invitation.inspect': undefined
  'auth.invitation.accept': undefined
  'auth.emailChange.inspect': undefined
  'auth.emailChange.complete': undefined
  'account.logout': undefined
  'account.profile.show': undefined
  'account.profile.update': undefined
  'account.password.change': undefined
  'account.emailVerification.send': undefined
  'account.invitation.send': undefined
  'account.invitation.list': { limit?: number; cursor?: string }
  'account.invitation.resend': undefined
  'account.invitation.revoke': undefined
}

export type ManagedQuery<Name extends ManagedEndpointName> = ManagedQueries[Name]

/** A write committed, but a post-commit callback or delivery failed. */
export interface ManagedCommittedSuccess {
  committed: true
}

/** Base response bodies before application-owned account representation is added. */
export interface ManagedSuccessBodies {
  'auth.signup':
    { account: CurrentAccount; token?: string } | { registered: true; authenticated: false }
  'auth.csrf': { csrfToken: string }
  'auth.login': { account: CurrentAccount; token?: string }
  'auth.passwordReset.request': { message: string }
  'auth.passwordReset.inspect': { valid: true }
  'auth.passwordReset.complete': { reset: true } | ManagedCommittedSuccess
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
