# Compatibility

This package remains an unpublished `0.0.0` candidate. The versions below are the concrete
environment used for the package-side validation at accepted stage-6 commit
`64e154203c0bf1aaf36957e97f39f2d440aa2ccb`. They are tested points, not a claim that every
version in each peer range has been verified.

| Component | Tested version | Declared support |
| --- | --- | --- |
| Node.js | 24.19.0 | `>=24.0.0` |
| pnpm | 11.23.0 | Repository package manager |
| `@adonisjs/core` | 7.6.0 | peer `^7.0.0` |
| `@adonisjs/lucid` | 22.4.2 | peer `^22.0.0` |
| `@adonisjs/limiter` | 3.0.1 | peer `^3.0.0` |
| Luxon | 3.7.2 | peer `^3.0.0` |
| `@adonisjs/assembler` | 8.5.2 | optional peer `^8.0.0` (configure tooling) |
| Knex | 3.3.0 | Lucid transitive dependency; no package peer range |
| `pg` | 8.23.1 | PostgreSQL test driver; no package peer range |
| PostgreSQL | 16.15 | Tested database server |
| `better-sqlite3` (package suite) | 12.11.1 | SQLite test driver; no package peer range |
| SQLite (package suite) | 3.53.2 | Native version bundled by tested `better-sqlite3` |
| `@adonisjs/auth` (consumer app) | 10.1.0 | Consumer rehearsal dependency |
| `better-sqlite3` (consumer app) | 13.0.3 | Consumer rehearsal driver; no package peer range |
| SQLite (consumer app) | 3.53.4 | Native version bundled by consumer `better-sqlite3` |

At the accepted stage-6 source commit, package tests passed with 121 SQLite tests and 123
PostgreSQL tests. A later SQLite-only regression test raised the pre-correction package totals to
122 and 123. The subsequent review corrections pass 129 SQLite tests and 130 PostgreSQL tests;
lint, typecheck, build and the two-test built-export smoke gate pass. Runtime source includes those
corrections. In the earlier fresh and upgraded API-kit consumers, one HTTP workflow test per database
passed in the fresh app and two per database passed after upgrade; consumer typecheck passed in
both rehearsals. The consumer used the versions in this table plus Core 7.6.0, assembler 8.5.2,
Lucid 22.4.2, Knex 3.3.0, Luxon 3.7.2, limiter 3.0.1, `pg` 8.23.1, and PostgreSQL 16.15.

The repaired archive was subsequently installed through pnpm in a private copy of that configured
API consumer. Consumer typecheck and two functional HTTP tests per database passed against the
new runtime. This does not repeat fresh-app generation or the original stage-3 upgrade rehearsal;
see the T8.5 correction record in [manual verification](manual-check.md#t85-consolidated-review-corrections).

The upgrade began from the stage-3 package archive, which already had all four package migrations.
Candidate configure preserved the existing config and provider, skipped those migrations, and
added no package migration; migration runs reported no pending work and the verified baseline
account remained present. A separate consumer role-fixture migration was added later. See the
[manual consumer verification record](manual-check.md) for the workflow coverage and archive
details. Stage-7 fork-derived stubs, browser checks, and owner application integration remain
deferred.

The consumer supplies the runtime peer packages listed above. The `pg` and `better-sqlite3`
drivers are used by the test setup and must be installed by consumer applications that use the
corresponding Lucid database client.

The generated adapter requires normalized lowercase email storage and a unique email index. On
PostgreSQL that constraint must be named `users_email_unique`. Lookup uses exact equality so the
ordinary email index can serve it.
When `users.id` is a string or UUID, update the user foreign-key column in each of the three
generated account tables to use the matching database type.

Credential operations lock the user before consuming or modifying either token table, avoiding
the former opposing user/token lock order. PostgreSQL does not retry transactions; general
transient database errors can still propagate to the caller. SQLite
retries write contention asynchronously within a five-second deadline. Package write helpers own
their root transaction, so an active global transaction is rejected on both dialects. Invitation
resend and revoke authorization callbacks run while that transaction is active and may run again
after a SQLite retry. If a callback reads through the ordinary SQLite connection pool, the pool
must have capacity for that separate read; a one-connection pool will time out. Preload permission
state where practical and size the pool for the app's concurrency. A larger pool alone does not
guarantee capacity under arbitrary concurrent load. See the
[transaction guidance](../README.md#package-transactions).

## Dependency audit

`pnpm audit` on 2026-10-13 against the candidate lockfile reported 16 advisories: 7 high, 6
moderate, and 3 low, with no critical advisories. The reported paths are:

- `undici 6.23.0`: 14 advisories (5 high, 6 moderate, 3 low) through `release-it` and
  `@release-it/conventional-changelog`; these are release-tool dependencies.
- `basic-ftp 5.3.1`: one high advisory, [GHSA-c475-qrg2-pj4r](https://github.com/advisories/GHSA-c475-qrg2-pj4r),
  through `release-it`'s proxy-agent dependency chain.
- `braces 3.0.3`: one high advisory, [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
  through `fast-glob > micromatch > braces`. This tree reaches assembler via Adonis peer packages;
  the advisory has no published patched version according to the audit result.

`pnpm audit --prod` reported zero dependencies and zero advisories because this package declares
runtime peers rather than production dependencies. That result omits the consumer's installed
peer dependency tree and is not a clean-audit claim. Consumers should audit their full install,
including runtime peers.

In the inspected versions, assembler passes configured metadata and package-copy glob patterns to
`fast-glob`, whose brace expansion reaches `braces`. The package's account inputs are not passed
to that parser by this package. This static trace found no request-time account-input path to the
advisory; it does not assess arbitrary consumer code or attacker-controlled build configuration.
