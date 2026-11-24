# US-ACCOUNT-59 — Discover available authentication methods

As a visitor, I want to see which authentication methods are available so that I can choose a sign-in path without revealing an account lookup.

**Status:** Current when `socialAuthentication` and its public managed `auth.methods` route are enabled and mounted
**Access:** Public; returns configured provider names and an optional visitor-local `lastUsedMethod` hint, never account data.
**Entry:** `GET auth/methods` on the mounted managed social route group.
**Documentation:** [Managed social routes](../docs/guide/managed-social.md#last-used-method)
**Source:** [`src/http/managed_social_account_handlers.ts`](../src/http/managed_social_account_handlers.ts), [`src/http/routes.ts`](../src/http/routes.ts)
**Coverage:** [`tests/managed_social_http.spec.ts`](../tests/managed_social_http.spec.ts)

## Acceptance criteria

- The public endpoint returns enabled provider names and nullable `lastUsedMethod` without looking up an account.
- The handler reads the session hint and uses the host’s `lastUsedMethod(context)` result instead when configured. It allowlists the selected value to `password` or one of `extensions.social.providers`, with `null` for an absent or unrecognised selection.
- When the endpoint is mounted, successful managed password login or a managed social credential handoff attempts to remember the visitor-local hint in the session and then via optional `rememberLastUsedMethod(context, method)`. A session write failure skips the extension write; either failure leaves the completed sign-in valid. A failure reading the hint, including from `lastUsedMethod`, propagates from the methods request.

## User flow

```mermaid
flowchart TD
    A["Visitor opens a sign-in entry that asks for method choices"] --> B{"Is the managed social methods route mounted and enabled?"}
    B -->|No| C["Use the host's sign-in choices"]
    B -->|Yes| D["GET auth/methods returns configured providers and an optional local hint"]
    D --> E["Choose a listed provider or continue with the host's other sign-in choices"]
```

## Code flow

Scope: public managed route and visitor-local hint resolution; the host owns the sign-in screen.

```mermaid
flowchart TD
    A["registerManagedRoutes selects socialAuthentication without excluding auth.methods"] --> B["GET auth/methods reaches public social methods handler"]
    B --> D["auth.methods reads server-session hint; if configured, use lastUsedMethod extension result"]
    D -->|Read fails| X["Propagate methods-request failure"]
    D --> C["Allowlist selected value to password or enabled providers; respond 200 with providers and nullable lastUsedMethod"]
    P["Managed password login or social handoff succeeds with auth.methods mounted"] --> W["rememberManagedMethod attempts session write, then optional extension write"]
    W -->|Write fails| Y["Suppress hint failure; retain established sign-in"]
```

**Code references:** [`managed social handler`](../src/http/managed_social_account_handlers.ts), [social route registration](../src/http/routes.ts), [managed mounting and methods flag](../src/http/managed.ts), [password hint producer](../src/http/handlers_authentication.ts), [social hint producers](../src/http/social.ts), [hint writer](../src/http/last_used_method.ts), [`managed social tests`](../tests/managed_social_http.spec.ts)
