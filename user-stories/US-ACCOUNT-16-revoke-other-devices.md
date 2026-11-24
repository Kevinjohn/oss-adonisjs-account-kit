# US-ACCOUNT-16 — Sign out other devices

As a signed-in account holder, I want to end every other recorded sign-in so that I can keep the credential performing the action available.

**Status:** Current when `sessionManagement` is enabled and `authentication` is configured
**Access:** Authenticated current account; operation excludes the current sign-in.
**Entry:** Host calls `authentication.sessions.revokeOthers({ current })` or mounts `account.sessions.revokeOthers` (POST `account/sessions/revoke-others`, limited access).
**Documentation:** [signed-in-devices.md](../docs/guide/signed-in-devices.md)
**Source:** [`src/session_management.ts`](../src/session_management.ts)
**Coverage:** [`tests/session_management.spec.ts`](../tests/session_management.spec.ts)

## Acceptance criteria

- **Inputs and result:** `authentication.sessions.revokeOthers({ current })` returns `{ count }`. It deletes other sign-in rows owned by the current account and preserves the sign-in that authenticated the action.
- Managed success returns 200 with the same `{ count }`. A count of zero skips the per-row transaction callback; the configured lifecycle observer still receives the result.
- If the managed write recognises a committed follow-up failure, it returns 202 with `{ committed: true }`.

## User flow

```mermaid
flowchart TD
 A["Account holder chooses sign out other devices"] --> B{"Does current credential validate and map to a sign-in?"}
 B -->|No| C["Return authentication refusal"]
 B -->|Yes| D["Revoke other account sign-ins and keep this one active"]
 D --> E["Show number of other sign-ins ended"]
```

## Code flow

```mermaid
flowchart TD
  M["Managed route resolves current credential"] --> A["authentication.sessions.revokeOthers"]
  H["Host supplies current credential evidence"] --> A
  A --> B["Require configuration and recheck credential and current sign-in in transaction"]
  B -->|Refused| X["Propagate current-credential refusal"]
  B -->|Accepted| C["Delete account-owned rows excluding current ID"]
  C -->|Deleted rows| D["Run configured transaction hook with deleted IDs"]
  C -->|Zero deleted| E["Commit without per-row hook"]
  D --> E2["Commit"]
  E --> F["Run lifecycle event with count; return count or committed follow-up error"]
  E2 --> F
  F -->|Managed success| G["Return 200 with count"]
```

**Code references:** [implementation](../src/session_management.ts), [`tests/session_management.spec.ts`](../tests/session_management.spec.ts), [managed sessions](../src/http/handlers_session_management.ts), [managed committed-failure response](../src/http/managed.ts)
