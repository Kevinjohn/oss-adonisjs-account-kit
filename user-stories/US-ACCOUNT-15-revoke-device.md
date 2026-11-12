# US-ACCOUNT-15 — Sign out a selected device

As a signed-in account holder, I want to revoke one of my recorded sign-ins so that I can end access from a device they no longer trust.

**Status:** Current when `authentication.sessions` (requires `sessionManagement`) is enabled
**Access:** Authenticated current account; target id is scoped to the account. The service allows revoking the current sign-in and reports that fact.
**Entry:** Host calls `authentication.sessions.revoke({ current, id })`; optional managed route.
**Documentation:** [signed-in-devices.md](../docs/guide/signed-in-devices.md)
**Source:** [`src/session_management.ts`](../src/session_management.ts)
**Coverage:** [`tests/session_management.spec.ts`](../tests/session_management.spec.ts)

## Acceptance criteria

- **Inputs and result:** `authentication.sessions.revoke({ current, id })` returns `{ current: boolean }`. It deletes only the caller’s matching sign-in; `current: true` means the target was the credential used for this request.

## User flow

```mermaid
flowchart TD
 A["Account holder selects a sign-in id"] --> B{"Is this id a positive integer naming one of the caller's sign-ins?"}
 B -->|No| C["Return not-found refusal without exposing another account's sign-in"]
 B -->|Yes| D["Delete that sign-in, including the current one when selected"]
 D --> E{"Was it current?"}
 E -->|Yes| F["Current request may finish; next use requires a new sign-in"]
 E -->|No| G["Selected device is signed out; current device stays active"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["authentication.sessions.revoke"] --> B["Parse positive signIn id and verify current account in transaction"]
 B --> C["Delete row only where owner and id match"]
 C --> D{"Exactly one row deleted?"}
 D -->|No| E["Throw SessionNotFoundError"]
 D -->|Yes| F["Run transaction hook and commit; return { current }"]
 F --> G["Run post-commit revocation event"]
```

**Code references:** [implementation](../src/session_management.ts), [`tests/session_management.spec.ts`](../tests/session_management.spec.ts)
