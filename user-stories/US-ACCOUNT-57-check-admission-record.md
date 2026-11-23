# US-ACCOUNT-57 — Check a user's admission record

As an application developer, I want to check admission state inside my authorised workflow so that I can make an application decision using current or transaction-local evidence.

**Status:** Current when the admission module is installed
**Access:** The host must authorise the caller before invoking user-ID lookups. `decide(user, trx)` requires the caller to hold the user lock in `trx`; `record` and `isAdmitted` accept an optional transaction to include its uncommitted writes.
**Entry:** Host code calls `AccountAdmission.record(userId, trx?)`, `isAdmitted(userId, trx?)`, or `decide(user, trx)`.
**Documentation:** [Admission](../docs/guide/admission.md)
**Source:** [`src/admission/service.ts`](../src/admission/service.ts)
**Coverage:** [`tests/admission_record.spec.ts`](../tests/admission_record.spec.ts), [`tests/admission_decision.spec.ts`](../tests/admission_decision.spec.ts), [`tests/admission_invitation_evidence.spec.ts`](../tests/admission_invitation_evidence.spec.ts)

## Acceptance criteria

- `record` returns the stored admission record or `null` for an unknown user or missing row. `isAdmitted` evaluates the enabled requirements and returns `false` for an unknown user; it evaluates enabled requirements without credential validation or an independent activation check. A domain requirement needs a confirmed address.
- Passing the host's transaction lets `record` and `isAdmitted` observe its uncommitted admission writes. `decide(user, trx)` evaluates a loaded user using that transaction and requires the caller to hold the user lock.
- These lookups do not authenticate or authorise the caller; the host owns that boundary.

## User flow

```mermaid
flowchart TD
 A["Host workflow needs a user's admission state"] --> B{"Is the host caller authorised?"}
 B -->|No| C["Host refuses before calling Account Kit"]
 B -->|Yes| D{"Which result does the workflow need?"}
 D -->|Record| E["Use stored record or handle null"]
 D -->|Admitted result| F["Use whether the user is admitted"]
 D -->|Requirement details| G["Use the decision for a user already locked in the host transaction"]
```

## Code flow

Scope: host authorisation precedes these service methods; `decide` is evaluated within a caller-owned transaction and lock.

```mermaid
flowchart TD
 A["Host authorises caller"] --> B{"Which admission read is needed?"}
 B -->|record| C{"AccountAdmission.record finds user with given ID and optional trx?"}
 C -->|No| F["Return null"]
 C -->|Yes| L{"Admission row exists in supplied trx or default connection?"}
 L -->|No| F
 L -->|Yes| M["Project stored record with current user email"]
 B -->|isAdmitted| D{"AccountAdmission.isAdmitted finds user with given ID and optional trx?"}
 D -->|No| G["Return false"]
 D -->|Yes| J["Read row through supplied trx or default connection; return evaluateAdmission result's admitted boolean"]
 B -->|decide| E["With caller-held user lock, AccountAdmission.decide reads row in trx"]
 E --> H["Return complete evaluateAdmission decision"]
```

**Code references:** [`AccountAdmission.record`, `isAdmitted` and `decide`](../src/admission/service.ts), [`record tests`](../tests/admission_record.spec.ts), [`decision tests`](../tests/admission_decision.spec.ts), [requirement evaluation](../src/admission/decision.ts)
