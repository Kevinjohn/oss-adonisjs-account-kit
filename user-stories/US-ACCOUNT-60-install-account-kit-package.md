# US-ACCOUNT-60 — Install the Account Kit package

As an application operator, I want to run the package's configure step so that a new AdonisJS application gets the Account Kit config, migrations, provider and commands without hand-writing them.

**Status:** Operator
**Access:** Requires shell access to the application. The step never overwrites existing files; the operator still runs the migrations and reviews the generated config.
**Entry:** Run `node ace configure @kevinjohn/adonisjs-account-kit [--users-table] [--user-id-type] [--provider-registered] [--migration-directory=path]` after installing the GitHub release archive ([root install section](../README.md#install)). `node ace add` is not a substitute: it installs the package from the npm registry first, and the package ships as a release archive. [US-ACCOUNT-31](US-ACCOUNT-31-configure-account-kit.md) covers the later `account-kit:setup` action.
**Documentation:** [getting-started.md](../docs/guide/getting-started.md), [root install section](../README.md#install), [custom-schema.md](../docs/guide/custom-schema.md)
**Source:** [`configure.ts`](../configure.ts), exported as `configure` from [`index.ts`](../index.ts)
**Coverage:** [`tests/configure.spec.ts`](../tests/configure.spec.ts), [`tests/configure_contract.spec.ts`](../tests/configure_contract.spec.ts)

## Acceptance criteria

| Field                   | Control      | Required/default/conditions                                                                                                                                                                        |
| ----------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--users-table`         | String flag  | Optional; defaults to `users`. Must be a plain SQL identifier, otherwise the step stops with exit code 1 before any write.                                                                         |
| `--user-id-type`        | String flag  | Optional; defaults to `integer`. Allowed values are `integer`, `string` and `uuid`; they set the user-keyed column types in the generated migrations. Anything else stops with exit code 1.        |
| `--migration-directory` | String flag  | Optional application-relative path for a dynamic or multi-path Lucid migration configuration; pass it on every run when required.                                                                  |
| `--provider-registered` | Boolean flag | Optional. Only for an `adonisrc.ts` whose `providers` list cannot be inspected statically: it states that Account Kit is already registered exactly once, and the provider list is left unchanged. |

- The step writes `config/account_kit.ts`, generates the package migrations (skipping any whose migration file already exists, with a `Skipped` message), adds the `account_kit_provider` provider unless it is already registered, adds the package `commands` entry, and declares `APP_URL` and `FRONTEND_URL` in `start/env.ts`.
- Existing generated config and migration files are kept. Configure still updates registration in `adonisrc.ts`. If you replaced the default loader with [`defineCommands`](US-ACCOUNT-66-select-account-kit-commands.md), a rerun can add the default loader again. Review the `commands` array after configure and remove the added default entry to preserve your selection.
- An `adonisrc.ts` whose `defineConfig` call, config properties or syntax cannot be inspected (not a static object literal, computed properties, spreads that do not expose `providers` and `commands`, TypeScript syntax errors) stops with exit code 1 before any write, whatever the flags. A shape it cannot inspect logs restructuring guidance; a syntax error or an unloadable `adonisrc.ts` logs only `Unable to inspect adonisrc.ts: <reason>.` A `providers` list that cannot be inspected stops with exit code 1 and guidance unless `--provider-registered` is given.

- Configure uses the [shared migration destination and ordering rules](../docs/guide/setup.md#reconfigure-saved-choices). It reports an unsafe destination or migration order before writing any files.

## User flow

```mermaid
flowchart TD
    A["Operator runs configure with optional flags"] --> B{"Are the flags valid?"}
    B -->|No| C["See the error; nothing is written"]
    B -->|Yes| D{"Can adonisrc.ts be inspected?"}
    D -->|No| E["See the inspection error (restructuring guidance for an unsupported shape), fix adonisrc.ts, then rerun; nothing is written"]
    D -->|Yes| P{"Providers list inspectable, or --provider-registered given?"}
    P -->|No| E
    P -->|Yes| M{"Migration path and prerequisites reconciled?"}
    M -->|No| E2["Report migration path/order error before writes"]
    M -->|Yes| F["Config, migrations, provider, commands and env checks are added without overwriting existing files"]
    F --> G["Operator runs the migrations and edits the generated config"]
```

## Code flow

Scope: the exported `configure` function and its Assembler codemods. The host owns running migrations and editing the generated config.

```mermaid
flowchart TD
    A["configure(command)"] --> B["buildMigrationSchema validates users-table and user-id-type"]
    B --> C{"Flags valid?"}
    C -->|No| D["Log error and set exitCode 1"]
    C -->|Yes| E["hasRegisteredProvider inspects adonisrc.ts"]
    E --> F{"Config inspectable, and providers inspectable or provider-registered given?"}
    F -->|No| G["Log the inspection error (with restructuring guidance for an unsupported shape) and set exitCode 1"]
    F -->|Yes| M{"inspectMigrationDirectory and orderMigrations succeed?"}
    M -->|No| D
    M -->|Yes| H["makeUsingStub writes config and migrations; existing files are kept"]
    H --> I["updateRcFile adds provider when absent, and the commands entry"]
    I --> J["defineEnvValidations declares APP_URL and FRONTEND_URL"]
```

**Code references:** [`configure`](../configure.ts), [`buildMigrationSchema`](../src/setup/migration_definitions.ts), [`providers inspection`](../src/setup/providers_inspection.ts), [command registration inspection](../src/setup/commands_inspection.ts), [migration directory](../src/setup/migration_paths.ts), [migration ordering](../src/setup/migration_order.ts), [`config stub`](../stubs/config/account_kit.stub), [`tests/configure.spec.ts`](../tests/configure.spec.ts)
