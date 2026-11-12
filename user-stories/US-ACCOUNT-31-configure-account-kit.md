# US-ACCOUNT-31 — Preview and apply Account Kit setup

As an application operator, I want to configure package integration from reviewed setup choices so that I can generate a consistent starting point without overwriting owner files.

**Status:** Operator
**Access:** Existing conflicts block apply; host still owns guard, policies, route activation and migration execution.
**Entry:** Run `account-kit:setup` interactively or `--input`; preview by default, then `--apply` or `--check`.
**Documentation:** [setup.md](../docs/guide/setup.md)
**Source:** [`commands/setup.ts`](../commands/setup.ts)
**Coverage:** [`tests/setup_command.spec.ts`](../tests/setup_command.spec.ts)

## Acceptance criteria

- **Inputs and result:** interactive choices or JSON input; flags `--apply`, `--check`, `--production`. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- clean plan applies selected integration files; route mount activation remains a separate reviewed step.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Operator previews plan"]
    U1["conflict report causes correction with no writes"]
    U0 --> U1
    U2["clean plan applies selected integration files; route mount activation remains a separate reviewed step."]
    U1 --> U2
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["Setup.run"]
    C1["load/validate choices and inspect project"]
    C0 --> C1
    C2["build plan/conflicts"]
    C1 --> C2
    C3["preview or apply non-conflicting writes"]
    C2 --> C3
    C4["report readiness and next steps."]
    C3 --> C4
```

**Code references:** [implementation](../commands/setup.ts), [`tests/setup_command.spec.ts`](../tests/setup_command.spec.ts)
