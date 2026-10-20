// The public entry point of `adonisjs-account-kit/admission`.
export { defineAdmission } from './config.js'
export { AccountAdmission } from './service.js'
export type { AdmissionDependencies } from './service.js'
export type { AdmissionPage } from './listing.js'
export { admissionMiddleware } from './middleware.js'
export { withInvitationEvidence } from './invitation_evidence.js'
export { withAdmissionCleanup } from './cleanup.js'
export { AdmissionDecisionError, AdmissionRequiredError } from './errors.js'
export type {
  AdmissionApprovalStatus,
  AdmissionAuthorizeCallbacks,
  AdmissionConfig,
  AdmissionDecision,
  AdmissionDomainConfig,
  AdmissionEvent,
  AdmissionInvitationEvidence,
  AdmissionRecord,
  ResolvedAdmissionConfig,
} from './types.js'
