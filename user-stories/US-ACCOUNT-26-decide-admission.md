# US-ACCOUNT-26 — Review an admission request

As an authorized application approver, I want to approve or reject a pending person so that I can record an accountable admission decision.

**Status:** Current when approval is enabled
**Access:** Host `approval.authorize` decides who may list or decide; Account Kit defines no application roles or admin UI.
**Entry:** Host-owned controller invokes `AccountAdmission.approve` or `.reject` with actor and target; operator commands are a separate shell path.
**Documentation:** [admission.md](../docs/guide/admission.md)
**Source:** [`src/admission/decisions.ts`](../src/admission/decisions.ts)
**Coverage:** [`tests/admission_decision.spec.ts`](../tests/admission_decision.spec.ts), [`tests/admission_decisions.spec.ts`](../tests/admission_decisions.spec.ts)

## Acceptance criteria

- **Inputs and result:** actorId, target user and decision inputs; service returns changed/current record. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- configured event runs after commit.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Approver reviews request"]
    U1["authorization or transition conflict is refused"]
    U0 --> U1
    U2["allowed approve/reject records actor and result"]
    U1 --> U2
    U3["configured event runs after commit."]
    U2 --> U3
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["AccountAdmission.approve/reject"]
    C1["authorization callback and transaction load target"]
    C0 --> C1
    C2["transition rules update decision/actor"]
    C1 --> C2
    C3["commit"]
    C2 --> C3
    C4["onAdmissionEvent."]
    C3 --> C4
```

**Code references:** [implementation](../src/admission/decisions.ts), [`tests/admission_decision.spec.ts`](../tests/admission_decision.spec.ts), [`tests/admission_decisions.spec.ts`](../tests/admission_decisions.spec.ts)
