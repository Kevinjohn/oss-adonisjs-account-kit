# US-ACCOUNT-17 — Sign out everywhere

As a signed-in account holder, I want to revoke every recorded sign-in so that I can require a fresh sign-in on each device.

**Status:** Current when `authentication.sessions` (requires `sessionManagement`) is enabled
**Access:** Authenticated current account; action may end the credential used for this request.
**Entry:** Host calls `authentication.sessions.revokeAll({ current })`; optional managed route.
**Documentation:** [signed-in-devices.md](../docs/guide/signed-in-devices.md)
**Source:** [`src/session_management.ts`](../src/session_management.ts)
**Coverage:** [`tests/session_management.spec.ts`](../tests/session_management.spec.ts)

## Acceptance criteria

- **Inputs and result:** `authentication.sessions.revokeAll({ current })` returns `void`. It changes credential revision so every existing session/token, including the current one, must authenticate again.

## User flow

```mermaid
flowchart TD
 A["Account holder chooses sign out everywhere"] --> B{"Does current credential validate?"}
 B -->|No| C["Return authentication refusal"]
 B -->|Yes| D["Invalidate credential state for every sign-in"]
 D --> E["Current credential also ends; sign in again on the next request"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["authentication.sessions.revokeAll"] --> B["Authenticate and load account under transaction"]
 B --> C["credentialsChanged advances revision and invalidates all existing credentials"]
 C --> D["Commit account change"]
 D --> E{"Post-commit observer/event succeeds?"}
 E -->|Yes| F["Resolve void"]
 E -->|No| G["Report committed follow-up failure; all sign-ins remain invalid"]
```

**Code references:** [implementation](../src/session_management.ts), [`tests/session_management.spec.ts`](../tests/session_management.spec.ts)
