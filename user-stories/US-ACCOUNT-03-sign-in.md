# US-ACCOUNT-03 — Sign in with configured credentials

As an existing account holder, I want to sign in with email and password so that I can receive the configured session or access token.

**Status:** Current
**Access:** Credentials and the `canAccess` decision must pass; limiter budgets apply. Account Kit does not require an active account for password login. The host may enforce activation in `canAccess` or with `requireActive` on protected routes.
**Entry:** Host calls `authentication.login(input, guard)` or mounts `auth.login` (POST `auth/login`). An application using `accountKitSessionGuard` may obtain its request adapter with `ctx.auth.use(name).forRequest()`.
**Documentation:** [authentication.md](../docs/guide/authentication.md)
**Source:** [`src/authentication.ts`](../src/authentication.ts)
**Coverage:** [`tests/authentication.spec.ts`](../tests/authentication.spec.ts), [`tests/authentication_throttle.spec.ts`](../tests/authentication_throttle.spec.ts)

## Acceptance criteria

- **Inputs and result:** `authentication.login({ email, password, clientKey, sessionLabel? }, guard)` returns the safe current account and issued credential through the configured guard. `sessionLabel` is untrusted display text truncated to 255 characters; the guard strategy and access policy are configured by the host.

- Access-token issuance requires a usable identifier and a releasable bearer value. A malformed result raises an adapter contract error. On release failure the guard attempts cleanup when it has an identifier. If cleanup also fails it preserves both causes in an AggregateError. See [guard contract cases](../tests/managed_guard.spec.ts).
- If the `canAccess` decision or returned token violates its adapter contract, the managed route logs the mapped failure and returns a generic 500 with `E_ACCOUNT_KIT_OPERATION_FAILED`.
- Managed login validates `email` and `password`, takes the client key from the request IP and the label from `User-Agent`, and returns 200 with the represented account. The access-token strategy also returns the bearer `token`. The session strategy establishes browser session state.

## User flow

```mermaid
flowchart TD
 A["Person submits email and password"] --> M{"Does the host supply text inputs and a nonempty client key?"}
 M -->|No| N["Return generic login refusal before reserving attempts"]
 N --> A
 M -->|Yes| B{"Are credentials and access decision accepted?"}
 B -->|No| C["Return generic login refusal; apply failed-attempt budgets"]
 C --> A
 B -->|Yes| E{"Session or token established?"}
 E -->|Yes| D["Show signed-in state"]
 E -->|No| F["Report sign-in failure"]
```

## Code flow

```mermaid
flowchart TD
  U["Managed auth.login validates payload and supplies IP, User-Agent and request guard"] --> A["authentication.login"]
  V["Host calls with configured guard adapter"] --> A
  A --> M["Require matching configured guard and well-formed input"]
  M --> B["Reserve client budget then identity budget; release client reservation if identity reservation fails"]
  B --> C["Transaction finds candidate, locks account and verifies current email, password and canAccess"]
  C -->|Invalid credentials| E["Keep failed-attempt budgets, block identity when exhausted and wait for timing floor"]
  C -->|Unexpected verification error| EE["Release both reservations and propagate"]
  C -->|Accepted| R["Release client reservation and clear identity failures"]
  R --> S["establishCredential uses session revision and optional registry handle, or creates token with configured options"]
  S --> F["Locked transaction rechecks revision, email and canAccess; records session registry row and removes replaced handle when supplied"]
  F -->|Accepted| G["Return account and credential; managed handler returns strategy-specific 200"]
  S -->|Issuance fails| I["Propagate failure; attempt termination when possible"]
  F -->|Recheck fails| I
  I -->|Cleanup also fails| J["Aggregate issuance and cleanup errors"]
```

**Code references:** [implementation](../src/authentication.ts), [`tests/authentication.spec.ts`](../tests/authentication.spec.ts), [`tests/authentication_throttle.spec.ts`](../tests/authentication_throttle.spec.ts), [managed login](../src/http/handlers_authentication.ts), [credential issuance](../src/credential_issuance.ts), [token guard](../src/http/managed_token_guard.ts), [session guard adapter](../src/auth/session_guard.ts), [access decision contract](../src/account_access_decision.ts), [managed error mapping](../src/http/managed.ts)
