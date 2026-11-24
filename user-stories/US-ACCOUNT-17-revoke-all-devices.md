# US-ACCOUNT-17 — Sign out everywhere

As a signed-in account holder, I want to revoke every recorded sign-in so that I can require a fresh sign-in on each device.

**Status:** Current when `sessionManagement` is enabled and `authentication` is configured
**Access:** Authenticated current account; action may end the credential used for this request.
**Entry:** Host calls `authentication.sessions.revokeAll({ current })` or mounts `account.sessions.revokeAll` (POST `account/sessions/revoke-all`, limited access).
**Documentation:** [signed-in-devices.md](../docs/guide/signed-in-devices.md)
**Source:** [`src/session_management.ts`](../src/session_management.ts)
**Coverage:** [`tests/session_management.spec.ts`](../tests/session_management.spec.ts)

## Acceptance criteria

- **Inputs and result:** `authentication.sessions.revokeAll({ current })` returns `void`. It changes credential revision so every existing session/token, including the current one, must authenticate again.
- Managed success returns 204. The managed browser handler attempts session termination after commit, including when a post-commit follow-up fails.
- If the managed write recognises a committed follow-up failure, it returns 202 with `{ committed: true }`.

## User flow

```mermaid
flowchart TD
 A["Account holder chooses sign out everywhere"] --> B{"Does current credential validate?"}
 B -->|No| C["Return authentication refusal"]
 B -->|Yes| D["Invalidate credential state for every sign-in"]
 D --> E["Current credential also ends; sign in again on the next request"]
```

## Code flow

```mermaid
flowchart TD
  M["Managed route resolves current credential"] --> A["authentication.sessions.revokeAll"]
  H0["Host supplies current credential evidence"] --> A
  A --> B["Require configuration; transaction rechecks credential and resolves its sign-in"]
  B -->|Refused| X["Propagate current-credential refusal"]
  B -->|Accepted| C["invalidateChangedCredentials advances revision and invalidates existing credentials"]
  C --> D["Commit; run credential observer and lifecycle event"]
  D --> E["Return void or surface committed follow-up failure"]
  E -->|Managed| F["Attempt browser termination after commit; return 204 on success or rethrow for the managed committed-failure response"]
```

**Code references:** [implementation](../src/session_management.ts), [`tests/session_management.spec.ts`](../tests/session_management.spec.ts), [managed sessions](../src/http/handlers_session_management.ts), [session termination](../src/http/session_end.ts), [credential mutation](../src/credential_revision.ts), [managed committed-failure response](../src/http/managed.ts)
