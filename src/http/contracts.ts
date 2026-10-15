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

/** Base response bodies before application-owned account representation is added. */
export interface ManagedSuccessBodies {
  'auth.signup':
    { account: CurrentAccount; token?: string } | { registered: true; authenticated: false }
  'auth.csrf': { csrfToken: string }
  'auth.login': { account: CurrentAccount; token?: string }
  'auth.passwordReset.request': { message: string }
  'auth.passwordReset.inspect': { valid: true }
  'auth.passwordReset.complete': { reset: true }
  'auth.emailVerification.inspect': { valid: true }
  'auth.emailVerification.complete': { verified: true }
  'auth.invitation.inspect': { email: string; role: string }
  'auth.invitation.accept': { account: CurrentAccount }
  'auth.emailChange.inspect': { valid: true }
  'auth.emailChange.complete': { account: CurrentAccount }
  'account.logout': undefined
  'account.profile.show': { account: CurrentAccount }
  'account.profile.update': { account: CurrentAccount }
  'account.password.change': { changed: true }
  'account.emailVerification.send': { result: 'sent' | 'already_verified' }
  'account.invitation.send': { id: number }
  'account.invitation.list': InvitationPage
  'account.invitation.resend': { id: number }
  'account.invitation.revoke': undefined
}

export type ManagedSuccessBody<Name extends ManagedEndpointName> = ManagedSuccessBodies[Name]

type CompleteInventory =
  Exclude<ManagedEndpointName, keyof ManagedSuccessBodies> extends never
    ? Exclude<keyof ManagedSuccessBodies, ManagedEndpointName> extends never
      ? Exclude<ManagedEndpointName, keyof ManagedRequestBodies> extends never
        ? Exclude<keyof ManagedRequestBodies, ManagedEndpointName> extends never
          ? true
          : never
        : never
      : never
    : never

export const managedSuccessContractComplete: CompleteInventory = true

export interface ManagedErrorBody {
  errors: Array<{ code: string; message: string; field?: string } | { code: string; title: string }>
}
