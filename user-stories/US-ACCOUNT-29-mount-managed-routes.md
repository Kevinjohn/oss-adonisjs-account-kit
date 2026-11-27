# US-ACCOUNT-29 — Mount selected managed JSON routes

As an application integrator, I want to register the chosen service-backed endpoints so that I can reuse validated HTTP handlers while retaining host policy.

**Status:** Current when the application explicitly calls route registration
**Access:** Host chooses prefix, guard, enabled feature set, route exclusions and surrounding middleware; no frontend is supplied.
**Entry:** Call `managedRoutes.register(router, options)` from application routes.
**Documentation:** [managed-http.md](../docs/guide/managed-http.md)
**Source:** [`src/http/managed.ts`](../src/http/managed.ts)
**Coverage:** [`tests/managed_http_route_registration.spec.ts`](../tests/managed_http_route_registration.spec.ts), [`tests/managed_http_live_account.spec.ts`](../tests/managed_http_live_account.spec.ts)

## Acceptance criteria

- **Inputs and result:** `managedRoutes.register(router, { prefix, guard, kit, enabled, ... })` registers the enabled route groups under the chosen prefix and guard, plus the [session CSRF endpoint when applicable](US-ACCOUNT-61-obtain-session-csrf-token.md); `kit()` is required, while `verificationRequired` defaults to `true` when omitted. Exclusions and callbacks are host configuration. Route conflicts are checked when the router commits. The package supplies JSON handlers, not a frontend.

- For proof URL failures before a managed handler runs, the host can install the default `ManagedProofHeadersMiddleware` from `@kevinjohn/adonisjs-account-kit/middleware/proof_headers` before body parser and Shield. Use the [early server middleware wrapper](../docs/recipes/password-reset-existing-login.md#configure-and-mount-only-password-reset) with `server.use`, matching the mounted `prefix`, `strategy`, `enabled` and `except` selection; it applies `Cache-Control: no-store` and `Referrer-Policy: no-referrer` to matching proof routes before calling the next middleware.

- Selected handlers use the shared [managed request and response contract](REFERENCE.md#managed-request-and-response-boundary).

## User flow

```mermaid
flowchart TD
 A["Integrator configures prefix, guard and selected feature groups"] --> B{"Are options valid and route names/paths conflict-free?"}
 B -->|No| C["Fail startup/route commit with conflict detail"]
 B -->|Yes| D["Register selected guarded JSON endpoints"]
 D --> E["Client requests endpoint; host policy and service validation run"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["managedRoutes.register(router, options)"] --> B{"Router uncommitted and options valid?"}
 B -->|No| F
 B -->|Yes| C{"planManagedRoutes accepts selection and existing routes?"}
 C -->|No| F["Reject registration before serving requests"]
 C -->|Yes| H["Register selected handlers and recordManagedRegistration"]
 H --> D["Router commit runs managed collision checks"]
 D --> E{"Committed route inventory valid?"}
 E -->|No| F["Reject registration before serving requests"]
 E -->|Yes| G["Expose selected routes; no frontend is generated"]
 P["Host constructs ManagedProofHeadersMiddleware with route selection"] --> Q["planManagedRoutes selects proof routes"]
 Q --> R["handle matches request method and path, ignoring query string"]
 R -->|Proof route| S["applyProofHeaders before next middleware"]
 R -->|Other route| T["Call next middleware"]
 S --> T
```

**Code references:** [ManagedRoutes.register](../src/http/route_registration.ts), [route planning](../src/http/routes.ts), [option validation](../src/http/managed_options.ts), [early proof headers](../src/http/managed_proof_headers_middleware.ts), [proof-header failure and exclusion tests](../tests/managed_proof_headers.spec.ts), [`tests/managed_http_route_registration.spec.ts`](../tests/managed_http_route_registration.spec.ts), [`tests/managed_http_live_account.spec.ts`](../tests/managed_http_live_account.spec.ts)
