# US-ACCOUNT-17 — Sign out everywhere

As a signed-in account holder, I want to revoke every recorded sign-in so that I can require a fresh sign-in on each device.

**Status:** Current when `sessionManagement` is enabled
**Access:** Authenticated current account; action may end the credential used for this request.
**Entry:** Host calls `sessionManagement.revokeAll({ current })`; optional managed route.
**Documentation:** [signed-in-devices.md](../docs/guide/signed-in-devices.md)
**Source:** [`src/session_management.ts`](../src/session_management.ts)
**Coverage:** [`tests/session_management.spec.ts`](../tests/session_management.spec.ts)

## Acceptance criteria

- **Inputs and result:** current credential; returns completion. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- old credentials fail and a new login is required.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Person confirms sign out everywhere"]
    U1["current credential is checked"]
    U0 --> U1
    U2["all sign-ins are removed"]
    U1 --> U2
    U3["old credentials fail and a new login is required."]
    U2 --> U3
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["sessionManagement.revokeAll"]
    C1["verify current account and credential in transaction"]
    C0 --> C1
    C2["delete all sign-in records"]
    C1 --> C2
    C3["announce after commit"]
    C2 --> C3
    C4["return."]
    C3 --> C4
```

**Code references:** [implementation](../src/session_management.ts), [`tests/session_management.spec.ts`](../tests/session_management.spec.ts)
