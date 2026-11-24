// The public entry point of `@kevinjohn/adonisjs-account-kit/admission`.
export { defineAdmission } from './config.js'
export { AccountAdmission } from './service.js'
export { AdmissionCallbackRegistry } from './callback_registry.js'
export type { AdmissionDependencies } from './service.js'
export type { AdmissionPage } from './listing.js'
export { admissionMiddleware } from './middleware.js'
export { withInvitationEvidence } from './invitation_evidence.js'
export { withAdmissionCleanup } from './cleanup.js'
export { E_ACCOUNT_KIT_ADMISSION_DECISION, E_ACCOUNT_KIT_ADMISSION_REQUIRED } from '../errors.js'
export type {
  AdmissionApprovalStatus,
  AdmissionAuthorizeCallbacks,
  AdmissionCallbacks,
  AdmissionConfig,
  AdmissionDecision,
  AdmissionDomainConfig,
  AdmissionEvent,
  AdmissionInvitationEvidence,
  AdmissionRecord,
  ResolvedAdmissionConfig,
} from './types.js'
