// Public types of the admission module.
import type { Database } from '@adonisjs/lucid/database'
import type { AccountKit } from '../account_kit.ts'
import type { ResolvedConfig } from '../types_configuration.ts'
import type { AccountUser, AuthorizationContext, UserId } from '../types_foundation.ts'
import type { AdmissionApprovalStatus } from '../admission_decision.ts'

export type { AdmissionApprovalStatus, AdmissionDecision } from '../admission_decision.ts'

/** Your rules for admission decisions. Each callback must return exactly `true` to allow. */
export interface AdmissionAuthorizeCallbacks {
  /** Whether `actor` may approve, reject or revoke `subject`. */
  decide(actor: AccountUser, subject: AccountUser, context?: AuthorizationContext): Promise<boolean>
  /** Whether `actor` may list admission records. */
  list(actor: AccountUser, context?: AuthorizationContext): Promise<boolean>
}

/** Restricts admission to confirmed addresses on these domains. */
export interface AdmissionDomainConfig {
  /** Lowercase ASCII domains such as `example.com`. */
  allowed: string[]
  /** Also admit subdomains of each entry, such as `mail.example.com`. Default false. */
  includeSubdomains?: boolean
}

/** An admission event passed to `onAdmissionEvent` after commit. Carries ids only. */
export type AdmissionEvent =
  | { type: 'admission.requested'; userId: UserId; operationId: string }
  | {
      type: 'admission.approved' | 'admission.rejected' | 'admission.revoked'
      userId: UserId
      /** Null when an operator command decided. */
      actorId: UserId | null
      operationId: string
      source?: 'operator'
    }
  | {
      type: 'admission.invitation_granted'
      userId: UserId
      operationId: string
      source: 'operator'
    }

/**
 * `config/admission.ts`. Every requirement you include must be met; omit one to disable it. At
 * least one is required.
 */
export interface AdmissionConfig {
  /** Admit only confirmed addresses on these domains. */
  domain?: AdmissionDomainConfig
  /** Admit only people with invitation evidence, recorded by `withInvitationEvidence`. */
  invitation?: { required: true }
  /**
   * Admit only people an approver, or an operator command, approved. `authorize` is required here
   * or through `AdmissionCallbackRegistry`.
   */
  approval?: { required: true; authorize?: AdmissionAuthorizeCallbacks }
  /** Receives admission events after commit, for audit logs and notifications. */
  onAdmissionEvent?: (event: AdmissionEvent) => Promise<void>
}

/**
 * Callbacks an application provider registers through `AdmissionCallbackRegistry` instead of
 * passing them to `defineConfig`. Each field may come from one place only.
 */
export interface AdmissionCallbacks {
  /** `AdmissionConfig.approval.authorize`. */
  approvalAuthorize?: AdmissionAuthorizeCallbacks
  /** `AdmissionConfig.onAdmissionEvent`. */
  onAdmissionEvent?: (event: AdmissionEvent) => Promise<void>
}

/** The admission configuration after `defineConfig` validated it. */
export interface ResolvedAdmissionConfig {
  domain: { allowed: readonly string[]; includeSubdomains: boolean } | null
  invitation: boolean
  approval: { authorize: AdmissionAuthorizeCallbacks } | null
  onAdmissionEvent?: (event: AdmissionEvent) => Promise<void>
}

/** Invitation evidence recorded for an account. */
export interface AdmissionInvitationEvidence {
  /** The consumed invitation's id, or null for operator evidence. */
  invitationId: number | null
  /** The invited address at the time, kept as history. */
  email: string
  role: string | null
  /** When the evidence was recorded, as an ISO 8601 string. */
  recordedAt: string
  source: 'invitation' | 'operator'
}

/** One account's stored admission state. Timestamps are ISO 8601 strings. */
export interface AdmissionRecord {
  userId: UserId
  /** The account's current email address. */
  email: string
  /** When the person asked for approval, or null. */
  requestedAt: string | null
  invitation: AdmissionInvitationEvidence | null
  approval: {
    status: Exclude<AdmissionApprovalStatus, 'pending'>
    /** Null when an operator command decided. */
    actorId: UserId | null
    decidedAt: string
  } | null
  createdAt: string
  updatedAt: string
}

/** The dependencies the admission service is built from; the provider supplies them. */
export interface AdmissionDependencies {
  kit: AccountKit
  db: Database
  /** The resolved `config/account_kit.ts`. */
  accountConfig: ResolvedConfig
  /** The resolved `config/admission.ts`. */
  config: ResolvedAdmissionConfig
}

/** What the admission operations read: everything but the account service. */
export type AdmissionContext = Omit<AdmissionDependencies, 'kit'>

/** One page of admission records and the cursor for the next, or null. */
export interface AdmissionPage {
  items: AdmissionRecord[]
  nextCursor: string | null
}
