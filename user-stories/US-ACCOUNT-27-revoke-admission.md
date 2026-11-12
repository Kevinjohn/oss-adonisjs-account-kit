# US-ACCOUNT-27 — Revoke a prior admission decision

As an authorized application approver, I want to revoke an admitted account’s decision so that I can remove admission eligibility while preserving the account credential.

**Status:** Current when approval is enabled
**Access:** Host approval authorization callback; revocation does not itself sign the user out.
**Entry:** Host-owned controller calls `AccountAdmission.revoke`; no built-in admission routes.
**Documentation:** [admission.md](../docs/guide/admission.md)
**Source:** [`src/admission/decisions.ts`](../src/admission/decisions.ts)
**Coverage:** [`tests/admission_decisions.spec.ts`](../tests/admission_decisions.spec.ts)

## Acceptance criteria

- **Inputs and result:** `AccountAdmission.revoke({ actorId, userId })` returns the updated record. The host approval callback authorizes the actor; only an approved decision can be revoked. Existing sessions remain, but later gated requests reevaluate admission and are refused.

## User flow

```mermaid
flowchart TD
 A["Approver selects an approved account to revoke"] --> B{"Is actor admitted and allowed to decide?"}
 B -->|No| C["Refuse without changing admission"]
 B -->|Yes| D{"Is subject currently approved?"}
 D -->|No| E["Refuse invalid transition"]
 D -->|Yes| F["Record revoked decision; next gated request is denied"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["AccountAdmission.revoke({ actorId, userId })"] --> B["Check actor admission and authorize.decide"]
 B --> C["Transaction loads subject and validates approved-to-revoked transition"]
 C --> D{"Transition allowed?"}
 D -->|No| E["Abort without session revocation or record change"]
 D -->|Yes| F["Persist revoked state; commit and emit event"]
 F --> G["Later admission.require reevaluates and denies"]
```

**Code references:** [implementation](../src/admission/decisions.ts), [`tests/admission_decisions.spec.ts`](../tests/admission_decisions.spec.ts)
