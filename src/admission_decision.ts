/** Where a person stands on approval. `pending` means no decision has been recorded yet. */
export type AdmissionApprovalStatus = 'pending' | 'approved' | 'rejected' | 'revoked'

/** Whether a person is admitted, and the state of each enabled requirement. */
export interface AdmissionDecision {
  /** True only when every enabled requirement is met. */
  admitted: boolean
  /** Only enabled requirements appear. */
  requirements: {
    domain?: { met: boolean; reason?: 'unverified' | 'not_allowed' }
    invitation?: { met: boolean }
    approval?: { met: boolean; status: AdmissionApprovalStatus; requested: boolean }
  }
}
