# US-ACCOUNT-56 — Read current admission status

As a signed-in account holder, I want the application to show my admission status before full access so that I know whether I can continue or need approval.

**Status:** Current when the admission module is installed
**Access:** A valid current credential is required. This read does not require an active account or an admitted decision; the host owns the limited status surface.
**Entry:** Host passes its authenticated guard's `CurrentAccountInput` to `AccountAdmission.current(input)`.
**Documentation:** [Admission](../docs/guide/admission.md)
**Source:** [`src/admission/service.ts`](../src/admission/service.ts)
**Coverage:** [`tests/admission_gate.spec.ts`](../tests/admission_gate.spec.ts), [`tests/admission_request.spec.ts`](../tests/admission_request.spec.ts)

## Acceptance criteria

- `current(input)` checks the guard evidence and evaluates admission in one transaction, returning `{ account, decision }`. Session evidence is `userId` and the current `revision` (explicit `null` before the first revision change), plus `sessionHandle` when sign-in tracking is enabled. Access-token evidence is `userId` and `tokenId` for the user's token. A valid tracked session can have its activity updated.
- Unknown users, invalid or revoked credentials, and accounts refused by `authentication.canAccess(user, trx)` fail with `E_ACCOUNT_KIT_INVALID_SESSION`. A non-boolean access decision throws `E_ACCOUNT_KIT_ADAPTER_CONTRACT`. An account may be inactive or lack admission and still receive status. The decision contains only enabled requirements and the combined `admitted` result. The host controls what it displays and applies the [protected-route gate](US-ACCOUNT-25-gate-application-route.md) separately.

## User flow

```mermaid
flowchart TD
 A["Signed-in person opens the host's admission status surface"] --> B{"Does the current account credential still allow access?"}
 B -->|No| C["Refuse status read"]
 B -->|Yes| D["Host can show current account and enabled admission requirements"]
```

## Code flow

Scope: Account Kit validates the supplied credential and evaluates admission; the host provides the status route. With tracked sessions, current-credential validation may update session activity metadata.

The runnable API example traces the controller and middleware entry in its [admission code flow](../examples/api/README.md#admission-code-flow).

```mermaid
flowchart TD
 A["AccountAdmission.current starts transaction and calls requireCurrentAccountInTransaction"] --> B{"Authentication enabled?"}
 B -->|No| L["Throw E_ACCOUNT_KIT_CAPABILITY_DISABLED"]
 B -->|Yes| M{"Lock and find user?"}
 M -->|No| G
 M -->|Yes| C{"Which credential strategy?"}
 C -->|Session| D["Check revision and, when tracked, require live session handle"]
 C -->|Access token| E["Check token row belongs to user"]
 D --> F{"Credential valid?"}
 E --> F
 F -->|No| G["Throw E_ACCOUNT_KIT_INVALID_SESSION for refusal"]
 F -->|Yes| N{"What does canAccess return?"}
 N -->|False| G
 N -->|Non-boolean| O["Throw E_ACCOUNT_KIT_ADAPTER_CONTRACT"]
 N -->|True| H["Touch tracked session if applicable and build account projection"]
 H --> I{"users.findById reloads user?"}
 I -->|No| G
 I -->|Yes| J["decide reads admission row and evaluateAdmission checks enabled requirements"]
 J --> K["Commit and return account and decision"]
```

**Code references:** [`AccountAdmission.current` and `decide`](../src/admission/service.ts), [`requireCurrentAccountInTransaction`](../src/authentication.ts), [`admission gate tests`](../tests/admission_gate.spec.ts), [requirement evaluation](../src/admission/decision.ts), [credential types](../src/types_authentication.ts), [access decision validation](../src/account_access_decision.ts)
