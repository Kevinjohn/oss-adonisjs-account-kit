// The public entry point of `@kevinjohn/adonisjs-account-kit/admission`.
export { defineConfig } from './config.ts'
export { AccountAdmission } from './service.ts'
export { AdmissionCallbackRegistry } from './callback_registry.ts'
export { withInvitationEvidence } from './invitation_evidence.ts'
export { withAdmissionCleanup } from './cleanup.ts'
export { E_ACCOUNT_KIT_ADMISSION_DECISION, E_ACCOUNT_KIT_ADMISSION_REQUIRED } from '../errors.ts'
export type {
  AdmissionApprovalStatus,
  AdmissionAuthorizeCallbacks,
  AdmissionCallbacks,
  AdmissionConfig,
  AdmissionDecision,
  AdmissionDependencies,
  AdmissionDomainConfig,
  AdmissionEvent,
  AdmissionInvitationEvidence,
  AdmissionPage,
  AdmissionRecord,
  ResolvedAdmissionConfig,
} from './types.ts'
