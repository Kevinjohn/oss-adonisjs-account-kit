# US-ACCOUNT-14 — Review signed-in devices

As a signed-in account holder, I want to see the account’s recorded sign-ins so that I can identify sessions that should be revoked.

**Status:** Current when `sessionManagement` is enabled and `authentication` is configured
**Access:** Authenticated current account; feature requires configured authentication and session management.
**Entry:** Host calls `authentication.sessions.list({ current })` or mounts `account.sessions.list` (GET `account/sessions`, limited access).
**Documentation:** [signed-in-devices.md](../docs/guide/signed-in-devices.md)
**Source:** [`src/session_management.ts`](../src/session_management.ts)
**Coverage:** [`tests/session_management.spec.ts`](../tests/session_management.spec.ts)

## Acceptance criteria

- **Inputs and result:** `authentication.sessions.list({ current })` returns the caller’s live sign-ins newest first, each with `id`, label, timestamps and a `current` marker. `current` includes `userId` and strategy-specific evidence: credential `revision` plus `sessionHandle` for a registry-backed session, or `tokenId` for an access token.
- Managed success returns 200 with `{ sessions }`. The session path may update the current sign-in’s last-seen timestamp during the credential check.

## User flow

```mermaid
flowchart TD
 A["Signed-in account holder opens device list"] --> B{"Does the current session or token validate?"}
 B -->|No| C["Return authentication refusal"]
 B -->|Yes| D["Show only this account's live sessions/tokens with current marker"]
```

## Code flow

```mermaid
flowchart TD
  M["Managed route resolves current credential"] --> A["authentication.sessions.list"]
  H["Host supplies current credential evidence"] --> A
  A --> B["Require sessionManagement and authentication"]
  B --> C["Transaction rechecks current credential with canAccess and resolves sign-in storage for strategy"]
  C -->|Refused| X["Propagate current-credential refusal"]
  C -->|Accepted| D["Read account-owned rows newest ID first and exclude expired rows from returned list"]
  D --> E["Return SignIn list with current marker or wrap as managed sessions response"]
```

**Code references:** [implementation](../src/session_management.ts), [`tests/session_management.spec.ts`](../tests/session_management.spec.ts), [managed sessions](../src/http/handlers_session_management.ts), [current credential check](../src/authentication.ts)
