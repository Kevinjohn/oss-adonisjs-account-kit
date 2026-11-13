# US-ACCOUNT-26 — Review an admission request

As an authorized application approver, I want to approve or reject a pending person so that I can record an accountable admission decision.

**Status:** Current when approval is enabled
**Access:** Host `approval.authorize` decides who may list or decide; Account Kit defines no application roles or admin UI.
**Entry:** Host-owned controller invokes `AccountAdmission.approve` or `.reject` with actor and target; operator commands are a separate shell path.
**Documentation:** [admission.md](../docs/guide/admission.md)
**Source:** [`src/admission/decisions.ts`](../src/admission/decisions.ts)
**Coverage:** [`tests/admission_decision.spec.ts`](../tests/admission_decision.spec.ts), [`tests/admission_decisions.spec.ts`](../tests/admission_decisions.spec.ts)

## Acceptance criteria

- **Inputs and result:** `AccountAdmission.approve({ actorId, userId })` or `.reject({ actorId, userId })` returns the updated admission record. The actor must be a different, admitted account; `approval.authorize.decide(actor, subject, context)` must return `true`. Approval can transition a record with no decision or a prior `rejected`/`revoked` decision to `approved`; rejection applies only when there is no decision yet. A disallowed transition leaves the record unchanged.

## User flow

```mermaid
flowchart TD
 A["Approver selects pending person and approve or reject"] --> B{"Is actor admitted and authorized to decide?"}
 B -->|No| C["Return authorization refusal"]
 B -->|Yes| D{"Does requested transition apply to this record?"}
 D -->|No| E["Return transition refusal; decision unchanged"]
 D -->|Yes| F["Record actor and decision; emit event after commit"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["AccountAdmission.approve/reject({ actorId, userId })"] --> B["Load distinct actor and subject; check admitted actor and authorize.decide"]
 B --> C["Approve from no decision/rejected/revoked, or reject from no decision"]
 C --> D{"Is requested transition allowed?"}
 D -->|No| E["Abort write with authorization/decision error"]
 D -->|Yes| F["Persist decision and actor; commit and emit event"]
```

**Code references:** [implementation](../src/admission/decisions.ts), [`tests/admission_decision.spec.ts`](../tests/admission_decision.spec.ts), [`tests/admission_decisions.spec.ts`](../tests/admission_decisions.spec.ts)
