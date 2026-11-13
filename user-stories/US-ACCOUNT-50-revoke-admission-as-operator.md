# US-ACCOUNT-50 — Revoke admission as an operator

As an application operator, I want to revoke an approved account from the trusted shell so that it no longer passes the admission gate.

**Status:** Operator
**Access:** Shell access and enabled approval requirement; the account remains able to sign in, but gated application routes reject it.
**Entry:** Run `account-kit:admission:revoke <email>`.
**Documentation:** [Admission operator commands](../docs/guide/admission.md#commands)
**Source:** [`src/admission/operator.ts`](../src/admission/operator.ts)
**Coverage:** [`tests/admission_commands.spec.ts`](../tests/admission_commands.spec.ts)

## Acceptance criteria

- Email identifies an existing account with approved state; success returns updated admission record, stores null actorId and emits operator-source event after commit.
- Missing account, disabled approval or invalid transition is reported; credential/session state is not revoked by this admission decision.

## User flow

```mermaid
flowchart TD
 A["Operator submits approved account email for revocation"] --> B{"Is account approved and approval capability enabled?"}
 B -->|No| C["Report command failure; keep prior decision"]
 B -->|Yes| D["Record revoked admission decision"]
 D --> E["Next gated request is denied while sign-in credential remains valid"]
```

## Code flow

Scope: operator admission transition; it does not invalidate sessions.

```mermaid
flowchart TD
 A["account-kit:admission:revoke"] --> B["AccountAdmission.operator.revoke({ email })"]
 B --> C["Lock subject and apply approved-to-revoked transition"]
 C --> D{"Transition succeeds?"}
 D -->|No| E["Write command failure"]
 D -->|Yes| F["Commit record and emit operator-sourced event"]
 F --> G["Later admission.require reevaluates and refuses protected route"]
```

**Code references:** [`operatorDecision`](../src/admission/operator.ts), [`revoke command`](../src/admission/commands/revoke.ts), [`command tests`](../tests/admission_commands.spec.ts)
