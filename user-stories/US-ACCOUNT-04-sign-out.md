# US-ACCOUNT-04 — Sign out the current credential

As a signed-in account holder, I want to sign out of the current session or token so that I can end access through the credential used for this request.

**Status:** Current
**Access:** Host authenticates the current request and passes its credential/guard context.
**Entry:** Host calls `authentication.logout`; optional managed logout route.
**Documentation:** [authentication.md](../docs/guide/authentication.md)
**Source:** [`src/authentication.ts`](../src/authentication.ts)
**Coverage:** [`tests/authentication.spec.ts`](../tests/authentication.spec.ts)

## Acceptance criteria

- **Inputs and result:** `authentication.logout(guard, credential?, current?)` returns `void`. The host authenticates the request and supplies its guard; a session registry row is removed when a current session handle is supplied and session management is enabled.

## User flow

```mermaid
flowchart TD
 A["Signed-in person submits sign-out"] --> B{"Does host guard accept current credential?"}
 B -->|No| C["Sign-out request fails authentication"]
 B -->|Yes| D["Terminate current session or token"]
 D --> E["Later use of that credential is denied"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["authentication.logout"] --> B["Require authentication configuration"]
 B --> C["Delete matching session registry row when current handle is supplied"]
 C --> D["Call guard.terminate with current credential"]
 D --> E["Resolve void"]
```

**Code references:** [implementation](../src/authentication.ts), [`tests/authentication.spec.ts`](../tests/authentication.spec.ts)
