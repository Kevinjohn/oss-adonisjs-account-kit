# US-ACCOUNT-28 — Install the optional admission module

As an application operator, I want to add admission migration, configuration, provider and commands so that I can make admission available for explicit host configuration.

**Status:** Operator
**Access:** Operator must configure at least one requirement, host approval authority and route middleware; installer does not create app roles/routes.
**Entry:** Run `account-kit:admission:install [--users-table] [--user-id-type]`; then review migration/config and run migrations.
**Documentation:** [admission.md](../docs/guide/admission.md)
**Source:** [`commands/admission_install.ts`](../commands/admission_install.ts)
**Coverage:** [`tests/admission_install_command.spec.ts`](../tests/admission_install_command.spec.ts)

## Acceptance criteria

- **Inputs and result:** `account-kit:admission:install [--users-table] [--user-id-type]` writes missing migration/config/provider/command-loader files and skips existing files. It does not define application roles, authorization callbacks or protected routes; the operator must review config and run migrations.

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
 A["AdmissionInstall.run"] --> B["Render config and migration stubs only when absent"]
 B --> C["Register admission provider and command loader in adonisrc"]
 C --> D["Report manual policy, migration and route-gating steps"]
```

**Code references:** [implementation](../commands/admission_install.ts), [`tests/admission_install_command.spec.ts`](../tests/admission_install_command.spec.ts)
