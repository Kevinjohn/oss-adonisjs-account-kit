# Candidate verification

Validation uses Node 24 and pnpm. Local checks are authoritative; the repository workflows remain manual and were not dispatched.

The local package gate on Node 24.21.0 and pnpm 11.23.0 passes lint, typechecking, build, 205
SQLite tests, 205 PostgreSQL 16.15 tests and four built-export tests. Coverage includes real Lucid
model hooks, central locking, transaction cleanup, bounded pagination, limiter privacy, credential
effects and pruning. Installed-consumer outcomes are recorded separately for the exact archive;
package test totals alone do not establish distribution compatibility.

The review fixes add regression coverage for early consumer-mode rejection, standalone dotenv
ignore rules, bounded cursor decoding, expiry-filtered indexed pagination, and normalized setter
values that survive commit. The copied environment template boots with its SQLite default after
an application key is supplied. The API fixture adds three authentication tests to its two existing
HTTP workflows: normalized known/unknown login limits, the client budget across rotating identities,
and the shared 128-character password boundary. Login keeps legacy passwords usable without an
input length cap. The independent review found no remaining correctness or security findings in
this tactical change.

## Reproducible checks

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm quick:test
pnpm test:built-exports
DB_CLIENT=pg DB_HOST=127.0.0.1 DB_PORT=55432 DB_USER=account_kit DB_DATABASE=account_kit_test pnpm test
pnpm test:adapter
pnpm test:consumer -- --database=sqlite
pnpm test:consumer -- --database=postgres
pnpm test:consumer -- --mode=minimum --compatibility=minimum --database=sqlite
pnpm test:consumer -- --mode=minimum --compatibility=minimum --database=postgres
```

The consumer harness writes an `evidence.json` record with the candidate revision, archive digest,
concrete dependency/database versions and each command outcome. A packed installation must
resolve its actual archive, with no repository-source link. The final candidate record accompanies
the pull request; historical development archives do not count as evidence for it.

The latest-compatible API fixture exercises fresh and upgraded applications on both databases,
including all HTTP flows, required profile data, string/UUID IDs and a custom table, confirmations,
non-disclosing recovery responses, permission failures, scanner-safe inspection, token revocation,
and retryable outbox delivery. The exact-floor consumer independently typechecks the public
package API and exercises rollback, deferred commit failure, post-commit failure and concurrent
acceptance on both databases. See [compatibility](compatibility.md) for the distinct dependency sets.

For upgrade checks, supply `--mode=upgrade --baseline-tarball=PATH --baseline-revision=REV`. For a
prebuilt immutable candidate, also supply `--candidate-tarball=PATH --candidate-revision=REV`.
Schema variants use `--mode=fresh --user-id-type=string` (or `uuid`) with
`--users-table=account_users`. The harness records a representative contention measurement; this
is a smoke check for blocking and duplicate acceptance, not a throughput benchmark.

## Mutation evidence

The previous SQLite application-row locking regression reproduced a phantom UPDATE-trigger audit entry before replacement. Normalized input and missing setup-hook regressions were demonstrated before their fixes. The current expiry-refresh pruning regression preserves a row refreshed after batch selection.

Nineteen scoped mutation runs deliberately weakened changed guards for normalized email, the
actual generated acceptance hook, trusted registration, capability checks, credential-hook
exclusivity, HMAC framing, the four invitation budgets, the three atomic credential hooks,
password notices, independent post-commit effects, pruning expiry rechecks, central PostgreSQL
row locking and SQLite writer locking. Every run produced an expected regression failure. Each
source file was restored byte-for-byte before integrated verification. These runs used disposable
fixtures; they do not claim mutation coverage for unchanged historical guards.

## Delivery boundaries

No package publication, version change, release, hosted workflow execution, starter integration or owner-application integration is included. The working name and final publication version remain owner decisions. Historical checkpoints are retained in the repository's [manual record](manual-check.md); they are not current candidate evidence.
