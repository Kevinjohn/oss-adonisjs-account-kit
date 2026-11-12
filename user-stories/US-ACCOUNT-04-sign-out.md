# US-ACCOUNT-04 — Sign out the current credential

As a signed-in account holder, I want to sign out of the current session or token so that I can end access through the credential used for this request.

**Status:** Current
**Access:** Host authenticates the current request and passes its credential/guard context.
**Entry:** Host calls `authentication.logout`; optional managed logout route.
**Documentation:** [authentication.md](../docs/guide/authentication.md)
**Source:** [`src/authentication.ts`](../src/authentication.ts)
**Coverage:** [`tests/authentication.spec.ts`](../tests/authentication.spec.ts)

## Acceptance criteria

- **Inputs and result:** current account and selected guard credential; result is logout completion. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- later request with it is denied.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Person chooses sign out"]
    U1["host submits current credential"]
    U0 --> U1
    U2["accepted credential is revoked"]
    U1 --> U2
    U3["later request with it is denied."]
    U2 --> U3
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["authentication.logout"]
    C1["authenticate current guard credential"]
    C0 --> C1
    C2["revoke it and its sign-in registry entry when enabled"]
    C1 --> C2
    C3["return logout result."]
    C2 --> C3
```

**Code references:** [implementation](../src/authentication.ts), [`tests/authentication.spec.ts`](../tests/authentication.spec.ts)
