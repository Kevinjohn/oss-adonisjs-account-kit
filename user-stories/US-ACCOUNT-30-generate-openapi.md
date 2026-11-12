# US-ACCOUNT-30 — Generate an OpenAPI document for mounted routes

As an application operator, I want to write a contract for the managed endpoints actually registered so that I can provide clients and reviewers with the active route surface.

**Status:** Operator
**Access:** Managed routes must already be registered in the application route inventory.
**Entry:** Run `account-kit:openapi [--output]`; command writes OpenAPI 3.1 for the discovered route set.
**Documentation:** [../reference/openapi.md](../docs/guide/../reference/openapi.md)
**Source:** [`commands/openapi.ts`](../commands/openapi.ts)
**Coverage:** [`tests/openapi.spec.ts`](../tests/openapi_command.spec.ts)

## Acceptance criteria

- **Inputs and result:** optional output path; routes are read from application router; result is a generated document. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- valid route inventory produces document containing only mounted endpoints.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Operator runs command"]
    U1["no registered managed routes yields an actionable error"]
    U0 --> U1
    U2["valid route inventory produces document containing only mounted endpoints."]
    U1 --> U2
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["OpenApi.run"]
    C1["inspect router route registry"]
    C0 --> C1
    C2["reject empty inventory"]
    C1 --> C2
    C3["generate spec and write selected destination."]
    C2 --> C3
```

**Code references:** [implementation](../commands/openapi.ts), [`tests/openapi.spec.ts`](../tests/openapi_command.spec.ts)
