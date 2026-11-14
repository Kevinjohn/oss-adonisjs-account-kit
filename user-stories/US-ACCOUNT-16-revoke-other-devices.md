# US-ACCOUNT-16 — Sign out other devices

As a signed-in account holder, I want to end every other recorded sign-in so that I can keep the credential performing the action available.

**Status:** Current when `sessionManagement` is enabled and `authentication` is configured
**Access:** Authenticated current account; operation excludes the current sign-in.
**Entry:** Host calls `authentication.sessions.revokeOthers({ current })`; optional managed route.
**Documentation:** [signed-in-devices.md](../docs/guide/signed-in-devices.md)
**Source:** [`src/session_management.ts`](../src/session_management.ts)
**Coverage:** [`tests/session_management.spec.ts`](../tests/session_management.spec.ts)

## Acceptance criteria

- **Inputs and result:** `authentication.sessions.revokeOthers({ current })` returns `{ count }`. It deletes other sign-in rows owned by the current account and preserves the sign-in that authenticated the action.

## User flow

```mermaid
flowchart TD
 A["Account holder chooses sign out other devices"] --> B{"Does current credential validate and map to a sign-in?"}
 B -->|No| C["Return authentication refusal"]
 B -->|Yes| D["Revoke other account sign-ins and keep this one active"]
 D --> E["Show number of other sign-ins ended"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["authentication.sessions.revokeOthers"] --> B["Authenticate current credential and resolve current sign-in in transaction"]
 B --> C["Delete account-owned rows whose id differs from current id"]
 C --> D["Run transaction revocation hook for deleted ids"]
 D --> E["Commit and run post-commit event, then return count; report committed follow-up failure if the event fails"]
```

**Code references:** [implementation](../src/session_management.ts), [`tests/session_management.spec.ts`](../tests/session_management.spec.ts)
