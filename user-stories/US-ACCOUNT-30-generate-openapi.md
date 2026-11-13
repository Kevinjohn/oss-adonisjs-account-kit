# US-ACCOUNT-30 — Generate an OpenAPI document for mounted routes

As an application operator, I want to write a contract for the managed endpoints actually registered so that I can provide clients and reviewers with the active route surface.

**Status:** Operator
**Access:** Managed routes must already be registered in the application route inventory.
**Entry:** Run `account-kit:openapi [--output]`; command writes OpenAPI 3.1 for the discovered route set.
**Documentation:** [OpenAPI reference](../docs/reference/openapi.md)
**Source:** [`commands/openapi.ts`](../commands/openapi.ts)
**Coverage:** [`tests/openapi_command.spec.ts`](../tests/openapi_command.spec.ts)

## Acceptance criteria

- **Inputs and result:** `account-kit:openapi` accepts optional `--output`, `--title` and `--api-version`; without output it prints JSON to stdout. It commits/inspects the host router and refuses when no managed route registration exists.

## User flow

```mermaid
flowchart TD
 A["Operator runs OpenAPI command"] --> B{"Are managed routes registered?"}
 B -->|No| C["Print actionable error and exit nonzero"]
 B -->|Yes| D["Generate OpenAPI 3.1 for mounted endpoints only"]
 D --> E{"Was output path supplied?"}
 E -->|No| F["Print document to stdout"]
 E -->|Yes| G["Write document to selected file"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["account-kit:openapi"] --> B["Commit queued router and inspect managedRouteRegistration"]
 B --> C{"Registration exists?"}
 C -->|No| D["Log error and set exitCode 1"]
 C -->|Yes| E["Generate OpenAPI 3.1 with optional title/version"]
 E --> F{"--output supplied?"}
 F -->|No| G["Print JSON"]
 F -->|Yes| H["Write JSON to resolved application path"]
```

**Code references:** [implementation](../commands/openapi.ts), [`tests/openapi_command.spec.ts`](../tests/openapi_command.spec.ts)
