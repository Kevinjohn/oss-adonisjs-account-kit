# US-ACCOUNT-27 — Revoke a prior admission decision

As an authorised application approver, I want to revoke an admitted account’s decision so that I can remove admission eligibility while preserving the account credential.

**Status:** Current when approval is enabled
**Access:** Host approval authorisation callback; revocation does not itself sign the user out.
**Entry:** Host-owned controller calls `AccountAdmission.revoke`; no built-in admission routes.
**Documentation:** [admission.md](../docs/guide/admission.md)
**Source:** [`src/admission/decisions.ts`](../src/admission/decisions.ts)
**Coverage:** [`tests/admission_decisions.spec.ts`](../tests/admission_decisions.spec.ts)

## Acceptance criteria

- `revoke({ actorId, userId })` requires enabled approval and the same distinct, admitted actor and `authorize.decide(actor, subject, { trx })` check as [US-ACCOUNT-26](US-ACCOUNT-26-decide-admission.md). The subject must exist and be `approved`; a refused transition preserves the existing decision.
- Success returns the record with revoked status, actor and decision time. The configured observer receives `admission.revoked` after commit. Its failure reports `PostCommitError` with revocation saved. Existing credentials remain valid subject to their own checks, and future admission gates refuse the account while approval is required and revoked.

## User flow

```mermaid
flowchart TD
 A["Approver selects an approved account to revoke"] --> B{"Is approval enabled and the distinct actor admitted and allowed to decide?"}
 B -->|No| C["Refuse without changing admission"]
 B -->|Yes| D{"Is the subject currently approved?"}
 D -->|No| E["Refuse the transition"]
 D -->|Yes| F["Save revoked decision and retain sign-in credentials"]
 F --> G{"Did a follow-up fail?"}
 G -->|Yes| H["Report failure with revocation saved"]
 G -->|No| I["Return updated admission record"]
 F --> J["Later protected request fails admission while approval is required"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["AccountAdmission.revoke calls decideAdmission with revoke"] --> B{"requireApproval passes?"}
 B -->|No| C["Throw CapabilityDisabledError"]
 B -->|Yes| D["In transaction, lock actor and subject in ID order"]
 D --> E{"Subject and distinct admitted actor exist, and authorize.decide returns true with trx?"}
 E -->|No| F["Abort with lookup or authorisation error"]
 E -->|Yes| G{"nextApprovalStatus sees approved?"}
 G -->|No| H["Throw AdmissionDecisionError"]
 G -->|Yes| I["applyTransition upserts revoked decision, actor and time"]
 I --> J["Commit; withAdmissionEvent invokes configured observer"]
 J --> K{"Follow-ups succeed?"}
 K -->|Yes| L["Return updated AdmissionRecord"]
 K -->|No| M["Throw PostCommitError with revocation saved"]
 J --> N["On a later gated request, require reevaluates the stored approval"]
```

**Code references:** [implementation](../src/admission/decisions.ts), [`tests/admission_decisions.spec.ts`](../tests/admission_decisions.spec.ts), [service and gate](../src/admission/service.ts), [committed events](../src/admission/events.ts)
