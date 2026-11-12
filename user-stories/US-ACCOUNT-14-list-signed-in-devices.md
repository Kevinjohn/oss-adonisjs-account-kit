# US-ACCOUNT-14 — Review signed-in devices

As a signed-in account holder, I want to see the account’s recorded sign-ins so that I can identify sessions that should be revoked.

**Status:** Current when `sessionManagement` is enabled
**Access:** Authenticated current account; feature requires configured authentication and session management.
**Entry:** Host calls `sessionManagement.list`; optional managed device routes.
**Documentation:** [signed-in-devices.md](../docs/guide/signed-in-devices.md)
**Source:** [`src/session_management.ts`](../src/session_management.ts)
**Coverage:** [`tests/session_management.spec.ts`](../tests/session_management.spec.ts)

## Acceptance criteria

- **Inputs and result:** current account; result is recorded sign-in list including label/timestamps. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- only own active sign-ins are returned; revoked/expired credentials are not represented as active.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Person opens device list"]
    U1["current credential is checked"]
    U0 --> U1
    U2["only own active sign-ins are returned; revoked/expired credentials are not represented as active."]
    U1 --> U2
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["sessionManagement.list"]
    C1["verify current credential/revision in transaction"]
    C0 --> C1
    C2["query sign-in records for that account"]
    C1 --> C2
    C3["return list."]
    C2 --> C3
```

**Code references:** [implementation](../src/session_management.ts), [`tests/session_management.spec.ts`](../tests/session_management.spec.ts)
