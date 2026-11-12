# US-ACCOUNT-03 — Sign in with configured credentials

As an existing account holder, I want to sign in with email and password so that I can receive the configured session or access token.

**Status:** Current
**Access:** Account must satisfy configured credential, verification and access policy; limiter budgets apply.
**Entry:** Host calls `authentication.login` with email, password, client key and selected guard; optional managed login route.
**Documentation:** [authentication.md](../docs/guide/authentication.md)
**Source:** [`src/authentication.ts`](../src/authentication.ts)
**Coverage:** [`tests/authentication.spec.ts`](../tests/authentication.spec.ts), [`tests/authentication_throttle.spec.ts`](../tests/authentication_throttle.spec.ts)

## Acceptance criteria

- **Inputs and result:** `authentication.login({ email, password, clientKey, sessionLabel? }, guard)` returns the safe current account and issued credential through the configured guard. `sessionLabel` is untrusted display text limited to 255 characters; the guard strategy and access policy are configured by the host.

## User flow

```mermaid
flowchart TD
 A["Person submits email and password"] --> B{"Are credentials, account state and access policy accepted?"}
 B -->|No| C["Return generic login refusal; apply failed-attempt budgets"]
 C --> A
 B -->|Yes| D["Issue configured session or token and show signed-in state"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["authentication.login"] --> B["Reserve client and identity attempt budgets"]
 B --> C["Transaction loads account, checks password, activity and canAccess"]
 C --> D{"Login checks pass?"}
 D -->|No| E["Record failed attempt and return generic invalid-credentials error"]
 D -->|Yes| F["Guard establishes credential; registry records sign-in when enabled"]
 F --> G["Return account and credential"]
```

**Code references:** [implementation](../src/authentication.ts), [`tests/authentication.spec.ts`](../tests/authentication.spec.ts), [`tests/authentication_throttle.spec.ts`](../tests/authentication_throttle.spec.ts)
