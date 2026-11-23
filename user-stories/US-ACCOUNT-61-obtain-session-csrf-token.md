# US-ACCOUNT-61 — Obtain a session CSRF token

As a browser client, I want the CSRF token for my session so that I can submit protected writes.

**Status:** Current

**Access:** Public session-only route. Managed route planning includes it for any nonempty capability selection unless explicitly excluded.

**Entry:** `auth.csrf` (GET `auth/csrf`) under the configured managed prefix.

**Documentation:** [Guide](../docs/guide/managed-http.md)

**Source:** [src/http/managed_execution.ts](../src/http/managed_execution.ts), [src/http/handlers_authentication.ts](../src/http/handlers_authentication.ts)

**Coverage:** [tests/managed_http_authentication.spec.ts](../tests/managed_http_authentication.spec.ts)

## Acceptance criteria

- Shield supplies a string on the request. The handler sends status 200, an object containing csrfToken and Cache-Control: no-store.
- Missing Shield CSRF middleware raises a configuration error before the handler runs. The access-token route set omits this endpoint.

## User flow

```mermaid
flowchart TD
    A["Browser requests session CSRF token"] --> B{"Is the session endpoint configured and available?"}
    B -->|Yes| C["Receive token for protected writes"]
    B -->|No| D["See configuration failure or unavailable endpoint"]
```

## Code flow

```mermaid
flowchart TD
  A["planManagedRoutes adds auth.csrf for nonempty session route selection unless excluded"] --> B["executeManagedRequest checks request.csrfToken"]
  B -->|Missing or non-string| D["Throw Shield configuration error before resolving Account Kit"]
  B -->|String| E["Resolve kit and assert guard name and strategy match configuration"]
  E --> C["auth.csrf handler sets Cache-Control no-store and returns 200 with csrfToken"]
```

**Code references:** [managed route selection](../src/http/routes.ts), [managed dispatch](../src/http/managed_execution.ts), [CSRF handler](../src/http/handlers_authentication.ts)
