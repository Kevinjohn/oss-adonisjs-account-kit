# US-ACCOUNT-30 — Generate an OpenAPI document for mounted routes

As an application operator, I want to write a contract for the managed endpoints actually registered so that I can provide clients and reviewers with the active route surface.

**Status:** Operator
**Access:** Managed routes must already be registered in the application route inventory.
**Entry:** Run `account-kit:openapi [--output <path>] [--title <title>] [--api-version <version>]`.
**Documentation:** [OpenAPI reference](../docs/reference/openapi.md)
**Source:** [`commands/openapi.ts`](../commands/openapi.ts)
**Coverage:** [`tests/openapi_command.spec.ts`](../tests/openapi_command.spec.ts)

## Acceptance criteria

- **Inputs and result:** `account-kit:openapi` accepts optional `--output`, `--title` and `--api-version`; title and version default to the host package name and version, with `Account API` and `0.0.0` as fallbacks. Without output it prints JSON to stdout. An output path is resolved from the application root. It commits/inspects the host router and refuses when no managed route registration exists.

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
 C -->|Yes| S["Resolve session cookie and host package defaults"]
 S -->|Session configuration fails| K0["Propagate configuration error"]
 S -->|Resolved| E["generateManagedOpenApi with optional title/version"]
 E --> V{"Generation succeeds?"}
 V -->|No| D
 V -->|Yes| F{"--output supplied?"}
 F -->|No| G["Print JSON"]
 F -->|Yes| H["Resolve path and write JSON"]
 H --> I{"Write succeeds?"}
 I -->|Yes| J["Report written path"]
 I -->|No| K["Propagate file error"]
```

**Code references:** [implementation](../commands/openapi.ts), [`tests/openapi_command.spec.ts`](../tests/openapi_command.spec.ts)
