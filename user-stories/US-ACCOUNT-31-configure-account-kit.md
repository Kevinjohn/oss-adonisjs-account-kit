# US-ACCOUNT-31 — Preview and apply Account Kit setup

As an application operator, I want to configure package integration from reviewed setup choices so that I can generate a consistent starting point without overwriting owner files.

**Status:** Operator
**Access:** Existing conflicts block apply. If login-method retirement is proposed, its impact inventory must be available, no affected account may remain, and the operator must acknowledge the configured maintenance window with `--retirement-maintenance-window`. The host still owns guard, policies, route activation and migration execution.
**Entry:** Run `account-kit:setup` interactively or `--input`; preview by default, then `--apply` or `--check`.
**Documentation:** [setup.md](../docs/guide/setup.md)
**Source:** [`commands/setup.ts`](../commands/setup.ts)
**Coverage:** [`tests/setup_command.spec.ts`](../tests/setup_command.spec.ts)

## Acceptance criteria

- **Inputs and result:** `account-kit:setup` accepts interactive choices or `--input`; no flag previews by default, `--apply` writes a conflict-free plan, `--check` inspects saved choices, and `--production` adds deployment checks. It writes selected integration files only; migration execution, guard policy and active route cutover remain operator-controlled.
- Removing an existing password or social login method is blocked when the impact inventory is unavailable or any account would lose its last usable method. With zero affected accounts, apply still requires `--retirement-maintenance-window` so retirement cannot race credential changes.

## User flow

```mermaid
flowchart TD
 A["Operator supplies setup choices"] --> B["Review preview and reported conflicts"]
 B --> C{"Does plan contain conflicts?"}
 C -->|Yes| D["Correct choices or owner-file conflicts; apply writes nothing"]
 C -->|No| E{"Operator chose --apply?"}
 E -->|No| F["Keep preview/check read-only"]
 E -->|Yes| G["Write selected files; operator reviews migrations and route activation separately"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["account-kit:setup"] --> B["Load interactive or JSON choices and validate"]
 B --> C["Inspect project files and build plan"]
 C --> D{"Conflict-free apply requested?"}
 D -->|No| E["Print preview/check results without writes"]
 D -->|Yes| F["Write allowed generated files and report readiness/next steps"]
```

**Code references:** [implementation](../commands/setup.ts), [`tests/setup_command.spec.ts`](../tests/setup_command.spec.ts)
