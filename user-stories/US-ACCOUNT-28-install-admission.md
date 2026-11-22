# US-ACCOUNT-28 — Install the optional admission module

As an application operator, I want to add admission migration, configuration, provider and commands so that I can make admission available for explicit host configuration.

**Status:** Operator
**Access:** Operator must configure at least one requirement, host approval authority and route middleware; installer does not create app roles/routes.
**Entry:** Run `account-kit:admission:install [--users-table=<table>] [--user-id-type=<integer|string|uuid>] [--migration-directory=<path>]`; defaults are `users` and `integer`. Then review migration/config and run migrations.
**Documentation:** [admission.md](../docs/guide/admission.md)
**Source:** [`commands/admission_install.ts`](../commands/admission_install.ts)
**Coverage:** [`tests/admission_install_command.spec.ts`](../tests/admission_install_command.spec.ts)

## Acceptance criteria

- **Inputs and result:** `InstallAdmission.run()` handles `account-kit:admission:install [--users-table=<table>] [--user-id-type=<integer|string|uuid>] [--migration-directory=<path>]`; defaults are `users` and `integer`. Invalid schema inputs or unresolved migration order or destination report an error and set the command exit code. New migrations go in the primary Lucid connection's migration directory, after existing timestamped migrations. For a dynamic path, the operator confirms the directory with `--migration-directory`; with several configured paths, the flag selects one, and is refused when another configured path already holds the admission migration. On a destination problem the installer writes nothing and says so. It writes missing config/migration and registers the provider/command loader, while preserving existing config and migration files. It does not define application roles, authorization callbacks or protected routes; the operator must review config and run migrations.

## User flow

```mermaid
flowchart TD
 A["Operator runs admission installer"] --> B{"Are target files already present?"}
 B -->|Yes| C["Keep existing files and report skipped artifacts"]
 B -->|No| D["Write migration and admission config; register provider and commands"]
 C --> E["Operator configures requirements and approval authority"]
 D --> E
 E --> F["Review migration, apply schema and gate host routes"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["InstallAdmission.run"] --> B{"Do supplied table and ID type produce a valid migration schema?"}
 B -->|No| C["Report schema error and set nonzero exit code"]
 B -->|Yes| M{"Can the installer resolve the primary Lucid path and migration order?"}
 M -->|No| N["Report migration error and set nonzero exit code"]
 M -->|Yes| D["Render config and migration stubs only when absent"]
 D --> E["Register admission provider and command loader in adonisrc"]
 E --> F["Report manual policy, migration and route-gating steps"]
```

**Code references:** [implementation](../commands/admission_install.ts), [`tests/admission_install_command.spec.ts`](../tests/admission_install_command.spec.ts)
