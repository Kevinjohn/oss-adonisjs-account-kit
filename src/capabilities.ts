// Capability registry: default state, required adapter methods and required hooks per capability.
import type {
  AuthorizationCallbacks,
  Capability,
  NotificationCallbacks,
  UrlCallbacks,
  UsersAdapter,
} from './types.js'

export type RequiredHook =
  | `authorize.${keyof AuthorizationCallbacks}`
  | `urls.${keyof UrlCallbacks}`
  | `notify.${keyof NotificationCallbacks}`
  | 'onInvitationAccepted'

export interface CapabilityRequirements {
  defaultOn: boolean
  adapterMethods: readonly (keyof UsersAdapter)[]
  requiredHooks: readonly RequiredHook[]
}

export const capabilityRegistry: Record<Capability, CapabilityRequirements> = {
  passwordReset: {
    defaultOn: true,
    adapterMethods: [
      'findByEmail',
      'findById',
      'setPassword',
      'setUnverifiedEmail',
      'markEmailVerified',
    ],
    requiredHooks: [
      'urls.passwordReset',
      'notify.passwordResetProvision',
      'notify.passwordResetCompleted',
    ],
  },
  emailVerification: {
    defaultOn: true,
    adapterMethods: ['findById', 'markEmailVerified', 'setPassword'],
    requiredHooks: ['urls.emailVerification', 'notify.accountActivationProvision'],
  },
  invitations: {
    defaultOn: false,
    adapterMethods: ['findByEmail', 'findById', 'create', 'markEmailVerified'],
    requiredHooks: [
      'authorize.invite',
      'authorize.manageInvitation',
      'authorize.listInvitations',
      'urls.invitation',
      'notify.invitationProvision',
      'onInvitationAccepted',
    ],
  },
  emailPasswordManagement: {
    defaultOn: true,
    adapterMethods: [
      'findByEmail',
      'findById',
      'setPassword',
      'setEmail',
      'setUnverifiedEmail',
      'markEmailVerified',
      'verifyPassword',
    ],
    requiredHooks: [
      'urls.emailChange',
      'urls.emailVerification',
      'notify.emailChangeProvision',
      'notify.accountActivationProvision',
      'notify.emailChanged',
      'notify.passwordChanged',
    ],
  },
  registration: {
    defaultOn: false,
    adapterMethods: ['findByEmail', 'findById', 'create'],
    requiredHooks: ['urls.emailVerification', 'notify.accountActivationProvision'],
  },
  socialAuthentication: {
    defaultOn: false,
    adapterMethods: ['findByEmail', 'findById', 'create', 'verifyPassword'],
    requiredHooks: ['notify.socialIdentityLinked', 'notify.socialIdentityUnlinked'],
  },
  sessionManagement: {
    defaultOn: false,
    adapterMethods: ['findById'],
    requiredHooks: [],
  },
}

export const capabilities = Object.keys(capabilityRegistry) as Capability[]
export const defaultCapabilities = capabilities.filter((name) => capabilityRegistry[name].defaultOn)
