# US-ACCOUNT-39 — Read the current account

As a signed-in account holder, I want the application to check my current account so that it can show safe identity and activation state.

**Status:** Current when authentication is configured
**Access:** The host passes identifiers from its authenticated guard; Account Kit validates credential revision and sign-in state.
**Entry:** Host calls `authentication.current({ userId, revision?, tokenId?, sessionHandle? })`.
**Documentation:** [Authentication](../docs/guide/authentication.md)
**Source:** [`src/authentication.ts`](../src/authentication.ts)
**Coverage:** [`tests/authentication.spec.ts`](../tests/authentication.spec.ts)

## Acceptance criteria

- `CurrentAccountInput` includes `userId` and the strategy-specific credential data: revision, tokenId for access-token guards, and sessionHandle when session management is enabled. `current` returns only id, email, unverifiedEmail, hasPassword and active.
- A revoked credential, mismatched revision or missing/foreign sign-in handle is rejected; host must not treat the returned snapshot as a replacement credential.

## User flow

```mermaid
flowchart TD
 A["Host reads the authenticated guard identity"] --> B{"Does current credential and revision still validate?"}
 B -->|No| C["Return sign-in refusal and ask person to authenticate again"]
 B -->|Yes| D["Return safe current account fields including active state"]
```

## Code flow

Scope: Account Kit credential validation and safe account projection; the host authenticates the incoming request.

```mermaid
flowchart TD
 A["authentication.current(CurrentAccountInput)"] --> B["Transaction reads account and checks credential revision/guard identifier"]
 B --> C{"Credential still current?"}
 C -->|No| D["Throw InvalidSessionError"]
 C -->|Yes| E["Return CurrentAccount safe-field projection"]
```

**Code references:** [`current`](../src/authentication.ts), [`currentInTransaction`](../src/authentication.ts), [`authentication tests`](../tests/authentication.spec.ts)
