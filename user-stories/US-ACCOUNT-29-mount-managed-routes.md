# US-ACCOUNT-29 — Mount selected managed JSON routes

As an application integrator, I want to register the chosen service-backed endpoints so that I can reuse validated HTTP handlers while retaining host policy.

**Status:** Current when the application explicitly calls route registration
**Access:** Host chooses prefix, guard, enabled feature set, route exclusions and surrounding middleware; no frontend is supplied.
**Entry:** Call `registerManagedRoutes(router, options)` from application routes.
**Documentation:** [managed-http.md](../docs/guide/managed-http.md)
**Source:** [`src/http/managed.ts`](../src/http/managed.ts)
**Coverage:** [`tests/managed_http_route_registration.spec.ts`](../tests/managed_http_route_registration.spec.ts), [`tests/managed_http_live_account.spec.ts`](../tests/managed_http_live_account.spec.ts)

## Acceptance criteria

- **Inputs and result:** router and explicit options including prefix, selected guard/features and exclusions. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- mounted endpoints call services and map their responses.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Integrator selects route set"]
    U1["invalid config or collision is rejected during route registration/commit"]
    U0 --> U1
    U2["mounted endpoints call services and map their responses."]
    U1 --> U2
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["registerManagedRoutes"]
    C1["validate options/features"]
    C0 --> C1
    C2["register selected routes with guards, validators and handlers"]
    C1 --> C2
    C3["app route commit detects collisions."]
    C2 --> C3
```

**Code references:** [implementation](../src/http/managed.ts), [`tests/managed_http_route_registration.spec.ts`](../tests/managed_http_route_registration.spec.ts), [`tests/managed_http_live_account.spec.ts`](../tests/managed_http_live_account.spec.ts)
