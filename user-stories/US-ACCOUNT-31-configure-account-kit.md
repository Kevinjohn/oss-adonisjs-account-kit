# US-ACCOUNT-31 — Preview and apply Account Kit setup

As an application operator, I want to configure package integration from reviewed setup choices so that I can generate a consistent starting point without overwriting owner files.

**Status:** Operator
**Access:** Existing conflicts block apply. If login-method retirement is proposed, its impact inventory must be available, no affected account may remain, and the operator must acknowledge the configured maintenance window with `--retirement-maintenance-window`. The host still owns guard, policies, route activation and migration execution.
**Entry:** Run `account-kit:setup` interactively or `--input`; preview by default, then `--apply` or `--check`.
**Documentation:** [setup.md](../docs/guide/setup.md)
**Source:** [`commands/setup.ts`](../commands/setup.ts)
**Coverage:** [`tests/setup_command.spec.ts`](../tests/setup_command.spec.ts)

## Acceptance criteria

- **Inputs and result:** `account-kit:setup` accepts the interactive prompts or the same JSON keys with `--input`; defaults, exact prompt labels, options and conditional questions are listed in the [setup choices reference](../docs/reference/setup-choices.md#interactive-interview). No flag previews by default, `--apply` writes a conflict-free plan, `--check` inspects saved choices, and `--production` adds deployment checks. It writes selected integration files only; migration execution, guard policy and active route cutover remain operator-controlled.
- Removing an existing password or social login method is blocked when the impact inventory is unavailable or any account would lose its last usable method. With zero affected accounts, apply still requires `--retirement-maintenance-window` to acknowledge a host-operated maintenance window. The flag does not lock credentials or prevent concurrent changes; the operator must enforce the window.

- Setup uses the [shared migration destination and ordering rules](../docs/guide/setup.md#reconfigure-saved-choices). Destination errors are blocking diagnostics. The host supplies the generated configuration’s callbacks, either inline or through the [provider callback registry](US-ACCOUNT-65-register-provider-callbacks.md).

- Setup inspects its supplied environment snapshot. A supplied variable takes precedence over files. Dotenv lookup then checks the mode-specific local file, the generic local file outside test/testing, the mode-specific file, and finally the base file. See [selected environment resolution](../src/setup/selected_environment_values.ts).

## User flow

```mermaid
flowchart TD
 A["Operator supplies setup choices"] --> B["Review preview and reported conflicts"]
 B --> C{"Does plan contain conflicts?"}
 C -->|Yes| D["Correct choices or owner-file conflicts; apply writes nothing"]
 C -->|No| R{"Setup diagnostics and any login-retirement checks accepted?"}
 R -->|No| H["Resolve diagnostics, migrate affected credentials, or arrange and acknowledge the maintenance window; no apply writes"]
 R -->|Yes| E{"Operator chose --apply?"}
 E -->|No| F["Keep preview/check read-only"]
 E -->|Yes| J{"Does apply complete?"}
 J -->|Yes| G["Review the generated files before running migrations or enabling routes"]
 J -->|No| I["Review the reported failure and any files already written before retrying"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["account-kit:setup"] --> B["Inspect project files and load interactive or JSON choices"]
 B --> C["With saved choices, run runtimeInventory for the proposed retirement"]
 C --> R["planSetup validates choices; log JSON report"]
 R --> D{"Check, preview or apply?"}
 D -->|--check| E["Exit with configuration-validity result; no writes"]
 D -->|Preview| P["Exit nonzero on error diagnostics; no writes"]
 D -->|Apply| G{"Blocking diagnostics or apply conflict?"}
 G -->|Yes| H["Refuse application"]
 G -->|No| L["Run applySetup"]
 L -->|Completes| F["Report written count"]
 L -->|Failure before writing| H
 L -->|Interrupted after a write| I["Report files already written; review before rerunning"]
```

**Code references:** [implementation](../commands/setup.ts), [planSetup](../src/setup/plan.ts), [validate and retirementDiagnostics](../src/setup/validate.ts), [applySetup](../src/setup/apply.ts), [`tests/setup_command.spec.ts`](../tests/setup_command.spec.ts)
