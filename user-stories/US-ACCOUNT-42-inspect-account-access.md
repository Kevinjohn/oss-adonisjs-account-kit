# US-ACCOUNT-42 — Inspect account access before acting

As an application operator, I want an authorized host workflow to inspect another account's eligibility and credential revision so that it can decide whether to offer access or support action.

**Status:** Current when authentication is configured
**Access:** `inspectAccountAccess` is not authentication; the host must authorize the caller before invoking it. Missing, restricted and optionally inactive accounts share the access-denied error.
**Entry:** Host authorizes its caller, then calls `authentication.inspectAccountAccess({ userId, requireActive })`.
**Documentation:** [Authentication](../docs/guide/authentication.md)
**Source:** [`src/account_access_inspection.ts`](../src/account_access_inspection.ts)
**Coverage:** [`tests/account_access_inspection.spec.ts`](../tests/account_access_inspection.spec.ts)

## Acceptance criteria

- Input is the target `userId` and required `requireActive` boolean; success returns `{ account, revision }`, a point-in-time snapshot. It accepts no target credential and does not authorize the host caller.
- Restricted, missing or required-inactive target accounts are not returned as eligible; callers must not keep a snapshot as lasting authorization.

## User flow

```mermaid
flowchart TD
 A["Host operator requests eligibility snapshot after host authorization"] --> B{"Did host authorize this caller?"}
 B -->|No| C["Do not call account inspection"]
 B -->|Yes| D["Inspect target account and required active state"]
 D --> E{"Is target eligible?"}
 E -->|No| F["Receive common access-denied outcome"]
 E -->|Yes| G["Receive safe account snapshot and current revision"]
```

## Code flow

Scope: read-only account inspection under a user lock; caller authorization is external.

```mermaid
flowchart TD
 A["authentication.inspectAccountAccess({ userId, requireActive })"] --> B["Lock/read target and run canAccess through supplied transaction"]
 B --> C{"Target exists and policy allows requested active state?"}
 C -->|No| D["Throw common AccountAccessDeniedError"]
 C -->|Yes| E["Return safe account plus credential revision"]
```

**Code references:** [`inspectAccountAccess`](../src/account_access_inspection.ts), [`authentication API`](../src/authentication.ts), [`inspection tests`](../tests/account_access_inspection.spec.ts)
