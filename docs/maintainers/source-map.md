# Public entry points and comment policy

The `exports` map in [package.json](../../package.json) defines supported imports. Generated API
routes below are relative to the documentation site's base. Run `pnpm docs:api` to regenerate
their Markdown sources under `docs/reference/api/`.

| Public subpath               | Source                              | Reference coverage                                                                                                                                                                    |
| ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| package root                 | `index.ts`                          | `reference/api/index/index`: service, configuration, notification and error exports                                                                                                   |
| `./types`                    | `src/types.ts`                      | Types are reexported and documented through the root reference                                                                                                                        |
| `./errors`                   | `src/errors.ts`                     | Error classes and aliases are reexported through the root reference and described in the [error guide](../reference/errors.md)                                                        |
| `./account_kit_provider`     | `providers/account_kit_provider.ts` | [Setup guide](../guide/setup.md); no separate TypeDoc entry                                                                                                                           |
| `./adapters/lucid`           | `adapters/lucid.ts`                 | Factory and public adapter shapes are reexported through the root reference                                                                                                           |
| `./adapters/sql`             | `adapters/sql.ts`                   | [Adapter guide](../guide/adapters.md); no separate TypeDoc entry or root factory export                                                                                               |
| `./adapters/drizzle`         | `adapters/drizzle.ts`               | Adapter guide; no separate TypeDoc entry or root factory export                                                                                                                       |
| `./adapters/prisma`          | `adapters/prisma.ts`                | Adapter guide; no separate TypeDoc entry or root factory export                                                                                                                       |
| `./testing/adapter_contract` | `testing/adapter_contract.ts`       | `reference/api/testing/adapter_contract/index`                                                                                                                                        |
| `./testing/notifications`    | `testing/notifications.ts`          | `reference/api/testing/notifications/index`                                                                                                                                           |
| `./services/main`            | `services/main.ts`                  | [Usage guide](../guide/usage.md) for the resolved service; its class is documented in the root reference                                                                              |
| `./http`                     | `http/main.ts`                      | `reference/api/http/main/index` and the [managed HTTP guide](../guide/managed-http.md)                                                                                                |
| `./transaction`              | `transaction/main.ts`               | `reference/api/transaction/main/index` and the [application-owned integration guide](../guide/application-owned-integration.md#transaction-helpers-for-packages-built-on-account-kit) |
| `./ally`                     | `src/ally_social_provider.ts`       | `createAllySocialProvider` is reexported through the root reference; [social integration guide](../guide/social-authentication.md)                                                    |
| `./commands`                 | `commands/main.ts`                  | [Operational guide](../guide/operations.md) and setup guide; no separate TypeDoc entry                                                                                                |
| `./admission`                | `src/admission/main.ts`             | [Admission guide](../guide/admission.md); no separate TypeDoc entry                                                                                                                   |
| `./admission/provider`       | `src/admission/provider.ts`         | Admission guide for provider registration; no separate TypeDoc entry                                                                                                                  |
| `./admission/commands`       | `src/admission/commands/main.ts`    | Admission guide for command setup and operations; no separate TypeDoc entry                                                                                                           |

A missing direct TypeDoc entry does not by itself establish a missing public symbol. Check root
reexports and the named guide before changing the reference configuration. The SQL, Drizzle,
Prisma and admission subpaths intentionally use authored guidance for their integration
contracts; add generated coverage when a concrete documentation gap warrants it.

## Comment policy

TypeDoc treats warnings as errors and validates export reachability, links, rewritten links,
missing comments and merge annotations. Its required reflection kinds include enums and enum
members, variables, functions, classes, interfaces, methods, accessors and type aliases. Private
and internal declarations are excluded.

Comments describe contracts, ordering and non-obvious constraints, including transaction
ownership, credential cleanup, delivery acknowledgement and post-commit recovery where relevant.
Use precise guarantees: attempted cleanup can fail, and a resend acknowledgement can preserve a
current proof without delivering another message. Keep meaningful local policies when comparing
packages rather than adding filler comments to make the configurations identical.

## Deliberate compatibility differences

Account Kit's descriptive account-error classes and explicit `./errors` entry serve its account
operation boundary. Masquerade's request-error union and Soft Delete's model lifecycle exceptions
serve different domains. Preserve existing aliases and published imports. Account Kit has a
single `./types` entry rather than Soft Delete's `./types/*` wildcard; add an alias only for a
concrete compatibility use case.

Preserve fallback message wording and punctuation during cosmetic cleanup, and preserve legal
notices, upstream credit and inherited copyright phrasing. These differences do not justify a
public API or attribution rewrite.
