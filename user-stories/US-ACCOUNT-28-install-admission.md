# US-ACCOUNT-28 — Install the optional admission module

As an application operator, I want to add admission migration, configuration, provider and commands so that I can make admission available for explicit host configuration.

**Status:** Operator
**Access:** Operator must configure at least one requirement, host approval authority and route middleware; installer does not create app roles/routes.
**Entry:** Run `account-kit:admission:install [--users-table] [--user-id-type]`; then review migration/config and run migrations.
**Documentation:** [admission.md](../docs/guide/admission.md)
**Source:** [`commands/admission_install.ts`](../commands/admission_install.ts)
**Coverage:** [`tests/admission_install_command.spec.ts`](../tests/admission_install_command.spec.ts)

## Acceptance criteria

- **Inputs and result:** optional users table and user id type; command reports created/skipped artifacts. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- operator configures policy, applies migration and gates app-owned routes.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Operator runs installer"]
    U1["missing artifacts are written without overwriting existing files"]
    U0 --> U1
    U2["operator configures policy, applies migration and gates app-owned routes."]
    U1 --> U2
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["AdmissionInstall.run"]
    C1["write config/migration stubs when absent"]
    C0 --> C1
    C2["register provider/commands"]
    C1 --> C2
    C3["print manual migration and policy steps."]
    C2 --> C3
```

**Code references:** [implementation](../commands/admission_install.ts), [`tests/admission_install_command.spec.ts`](../tests/admission_install_command.spec.ts)
