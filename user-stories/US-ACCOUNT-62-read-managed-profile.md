# US-ACCOUNT-62 — Read my managed profile

As a signed-in account holder, I want to read the representation exposed by my application so that I can display my current details.

**Status:** Current

**Access:** Limited-access route under the authentication capability.

**Entry:** `GET account/profile`

**Documentation:** [Guide](../docs/guide/managed-http.md)

**Source:** [src/http/managed_execution.ts](../src/http/managed_execution.ts), [src/http/handlers_authentication.ts](../src/http/handlers_authentication.ts)

**Coverage:** [tests/managed_http_authentication.spec.ts](../tests/managed_http_authentication.spec.ts)

## Acceptance criteria

- The guard resolves the current credential and authentication.current loads the account. Limited access allows accounts pending verification to reach this read.
- A stale or refused credential fails before representation. On success the handler returns 200 with account set to the host representation when supplied or the default public representation.

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
    A["Read guard evidence"] --> B{"Current account resolves?"}
    B -->|Yes| C["Represent account and return 200"]
    B -->|No| D["Propagate refusal"]
```
