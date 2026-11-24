# US-ACCOUNT-62 — Read my managed profile

As a signed-in account holder, I want to read the representation exposed by my application so that I can display my current details.

**Status:** Current

**Access:** Limited-access route under the authentication capability.

**Entry:** `account.profile.show` (GET `account/profile`) under the configured managed prefix.

**Documentation:** [Guide](../docs/guide/managed-http.md)

**Source:** [src/http/managed_execution.ts](../src/http/managed_execution.ts), [src/http/handlers_authentication.ts](../src/http/handlers_authentication.ts)

**Coverage:** [tests/managed_http_authentication.spec.ts](../tests/managed_http_authentication.spec.ts)

## Acceptance criteria

- The selected guard authenticates the current credential and is responsible for token expiry; `authentication.current` loads the account and checks the stored sign-in. Limited access allows accounts pending verification to reach this read.
- A stale or refused credential fails before representation. On success the handler returns 200 with account set to the host representation when supplied or the default public representation.
- The default representation returns `id`, `email`, `unverifiedEmail`, `hasPassword` and `active`. A registry-backed session check can update its last-seen timestamp.

## User flow

```mermaid
flowchart TD
    A["Account holder requests profile"] --> B{"Current credential accepted?"}
    B -->|Yes| C["Read profile details"]
    B -->|No| D["See authentication failure"]
```

## Code flow

```mermaid
flowchart TD
  A["executeManagedRequest resolves kit and asserts configured guard"] --> B["Configured managed guard authenticates session or token and reads evidence; guard owns token expiry"]
  B -->|Refused| D["Propagate refusal"]
  B -->|Evidence available| E["authentication.current locks account and checks revision/registry or token ownership, then canAccess"]
  E -->|Refused| D
  E -->|Accepted| F["Update session last-seen when due, then project current account"]
  F --> G["account.profile.show awaits host representation or default projection"]
  G -->|Success| H["Return 200 with account"]
  G -->|Host representation fails| D
```

**Code references:** [managed dispatch](../src/http/managed_execution.ts), [token guard](../src/http/managed_token_guard.ts), [profile handler](../src/http/handlers_authentication.ts), [current account check](../src/authentication.ts), [public projection](../src/http/response_helpers.ts)
