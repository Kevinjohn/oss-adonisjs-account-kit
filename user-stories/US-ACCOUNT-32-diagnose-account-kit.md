# US-ACCOUNT-32 — Diagnose Account Kit configuration

As an application operator, I want to check configuration and integration readiness so that I can find missing or inconsistent setup before serving account journeys.

**Status:** Operator
**Access:** Requires configured application; diagnostic output does not prove live workflow behaviour.
**Entry:** Run `account-kit:doctor [--app-url <origin>]` in the host application.
**Documentation:** [operations.md](../docs/guide/operations.md)
**Source:** [`commands/doctor.ts`](../commands/doctor.ts)
**Coverage:** [`tests/doctor.spec.ts`](../tests/doctor.spec.ts)

## Acceptance criteria

- **Inputs and result:** `account-kit:doctor` starts the app and reports configuration, limiter, backend-origin and database-table checks with a failing exit status when checks fail. The optional `--app-url` supplies the backend origin when it is absent from configured action URLs. The command does not itself read `APP_URL`; pass its value explicitly when needed. It resolves the same config and [registered callbacks](US-ACCOUNT-65-register-provider-callbacks.md) as the service. A resolution error stops the command before the checks. After passing checks, the final notice identifies unexercised delivery, credential revocation, application policy and routes.

## User flow

```mermaid
flowchart TD
 A["Operator runs doctor in configured application"] --> B{"Do static configuration and schema checks pass?"}
 B -->|No| C["Print failing check and fix guidance; exit nonzero"]
 B -->|Yes| D["Report static checks and explicitly unverified runtime workflows"]
 D --> E["Operator runs disposable-account smoke test separately"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["AccountKitDoctor.run"] --> R["resolveAccountKitConfig resolves config; defineConfig provider merges registered callbacks and validates"]
 R -->|Resolution fails| F["Propagate configuration error"]
 R -->|Resolves| B["runDoctor checks config, limiter binding, backend origin and tables"]
 B --> C{"Any failed check?"}
 C -->|Yes| D["Print check failures and exit nonzero"]
 C -->|No| E["Print passed checks and unverified delivery/revocation/policy/routes notice"]
```

**Code references:** [implementation](../commands/doctor.ts), [config resolution](../src/config_resolution.ts), [defineConfig provider](../src/config.ts), [checks](../src/doctor.ts), [`tests/doctor.spec.ts`](../tests/doctor.spec.ts)
