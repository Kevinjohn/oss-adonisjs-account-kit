// The public entry point of `@kevinjohn/adonisjs-account-kit/admission`.
export { defineConfig } from './config.ts'
export { AccountAdmission } from './service.ts'
export { AdmissionCallbackRegistry } from './callback_registry.ts'
export type { AdmissionDependencies } from './service.ts'
export type { AdmissionPage } from './listing.ts'
export { withInvitationEvidence } from './invitation_evidence.ts'
export { withAdmissionCleanup } from './cleanup.ts'
export { E_ACCOUNT_KIT_ADMISSION_DECISION, E_ACCOUNT_KIT_ADMISSION_REQUIRED } from '../errors.ts'
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
} from './types.ts'
