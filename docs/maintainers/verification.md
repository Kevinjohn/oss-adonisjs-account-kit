# Candidate verification

Validation uses Node 24 and pnpm. Local checks are authoritative; the repository workflows remain manual and were not dispatched.

The local package gate on Node 24.21.0 and pnpm 11.23.0 passes lint, typechecking, build, 221
SQLite tests, 221 PostgreSQL 16.15 tests and four built-export tests. Coverage includes real Lucid
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
pnpm test:pg-service
pnpm test:pg
pnpm test:adapter
pnpm test:consumer -- --database=sqlite
pnpm test:consumer -- --database=postgres
pnpm test:consumer -- --mode=minimum --compatibility=minimum --database=sqlite
pnpm test:consumer -- --mode=minimum --compatibility=minimum --database=postgres
pnpm test:consumer -- --mode=service-only --database=sqlite
pnpm test:consumer -- --mode=service-only --database=postgres
```

The service-only mode installs the packed candidate in a separate minimal application, builds
with full declaration checking, and boots the compiled account service with the selected
database. It verifies that authentication, session, shield, Tuyau, mail, and Ally integrations
are absent. Core and its transitive validation dependencies remain installed as required by
AdonisJS.

For authentication integration, the fresh API consumer runs both the default
`access_tokens` route group and the `session` route group using a server-side session store.
The session fixture exercises CSRF bootstrap, fixation protection, protected access, revision
revocation, and logout. Run the service-only mode separately
for both databases to check that optional Auth and Session imports do not enter the generic
service declarations.

### Vocabulary alignment: 15 October 2026

The vocabulary implementation and review fixes at `f526a5e4e94ff730a8f63873a23b54619820e288`
pass on Node 24.21.0 and pnpm 11.23.0: lint, typecheck, build, 221 SQLite tests, 221 PostgreSQL
16.15 tests and four built-export tests. Lint, typecheck, build and SQLite tests emit no warnings.
The 61 PostgreSQL service checks retain their passing evidence because their implementation and
harness are unchanged. The final source tree also passes the repository formatter.

Fresh and historical-upgrade packed API consumers pass on SQLite and PostgreSQL, including
configuration, migrations, application lint/format/typecheck and all five HTTP tests per consumer.
The upgrade scenario also runs its dedicated baseline and candidate assertions. Both database
runs installed the same candidate archive, SHA-256
`3a78a1823ddb3ea950ca0a1e880f522555da2fe5d0c2b0b4a72381836c7260f2`.
The historical stage-3 baseline archive was verified against SHA-256
`a98d746e90bef50bb71ba6d5bd4b0b138a302314bc2eeedcf998232b725606df`.
The PostgreSQL test server was stopped after validation. Later documentation-only changes do not
change the verified implementation; these archives are local test evidence, not published packages.

The upgrade fixture leaves a reset token outstanding before migration, then compares its ID,
user, email, hash, expiry and creation timestamp after the table rename. It inspects and redeems
the same proof, rejects replay, verifies the changed password and retains the user/role/migration
checks. The raw proof travels only through a mode-0600 temporary file, removed before redemption
assertions. A mutation that deleted token rows during migration failed at the expected missing-row
assertion; the harness was restored byte-for-byte before PostgreSQL verification.

The packaging regression first reproduced private-document inclusion, then passed with explicit
archive exclusions. Inspection of the actual candidate archive confirmed that private planning
and review files are absent while public documentation and examples remain. The minimum-version
SQLite consumer passes and its captured output reports `passwordReset` and `emailVerification`
in the public-operation marker, with corresponding current stage labels.

The numeric-seconds expiry helper and real encrypted email-verification proof regressions retain
their earlier mutation evidence: each failed without numeric handling and passed after restoration.
The verification proof remains valid after 59 minutes and expires by 61 minutes for a 3600-second
setting. All three requested review fixes are addressed; no required findings remain. No package
publication or hosted workflow execution was performed.

### Local PostgreSQL package tests

Use Node 24 (`nvm use`) and installed PostgreSQL 16 binaries. On macOS, install them with
`brew install postgresql@16`; the wrapper also supports a PostgreSQL 16 `pg_ctl` on PATH with
its companion utilities in the same directory. It does not install software or use Homebrew
services. Run `pnpm test:pg-service` for the isolated lifecycle regression checks.

`pnpm test:pg` starts the checkout's disposable server, runs the package suite and stops the
server on success, failure or interruption. Selectors are forwarded:
`pnpm test:pg --files=db.spec.ts`. A cluster explicitly started with `pnpm pg:start` is preserved;
managed tests refuse it until `pnpm pg:stop`.

| Setting  | Managed value              |
| -------- | -------------------------- |
| Host     | `127.0.0.1`                |
| Port     | `DB_PORT`, default `55432` |
| User     | `account_kit`              |
| Password | empty                      |
| Database | `account_kit_test`         |

Only `DB_PORT` configures the managed wrapper. It uses trust authentication, UTF-8, C locale,
loopback TCP without Unix sockets, and `fsync=off`. Data at `tmp/pg16` persists for reuse and is
disposable; logs are at `tmp/pg16.log`. Never store application or consumer data there.
Mutating commands hold a nonblocking checkout lock at `tmp/pg16.lock` throughout tests and cleanup.
Another checkout's cluster or an unrelated listener is never adopted.
Ownership checks verify the executable, complete managed command and physical process directory.
Process directory inspection uses macOS's built-in `/usr/sbin/lsof` or Linux `/proc`; Linux
also resolves the physical executable through `/proc`. Unavailable or ambiguous inspection
fails closed rather than stopping the process. Other platforms are rejected before startup.

For repeated runs, when other connection variables are unset or have their defaults:

```sh
pnpm pg:start
DB_CLIENT=pg pnpm quick:test
pnpm pg:stop

DB_PORT=55433 pnpm pg:start
DB_PORT=55433 DB_CLIENT=pg pnpm quick:test
DB_PORT=55433 pnpm pg:stop
```

For a shell with connection overrides, use the full fixed connection values when testing an
explicitly started cluster:

```sh
DB_CLIENT=pg DB_HOST=127.0.0.1 DB_PORT=55432 DB_USER=account_kit DB_PASSWORD= DB_DATABASE=account_kit_test pnpm quick:test --files=db.spec.ts
```

`bash bin/pg.sh status` reports the owned cluster's state (exit 0 running, 3 stopped). Readiness
at the selected port is diagnostic only. `bash bin/pg.sh reset` stops and deletes only the owned
disposable data, initializes it again and leaves a fresh server running; use `pnpm pg:stop`
afterward. Wrong-version or incomplete data requires this explicit reset.

After SIGKILL or power loss, a `postmaster.pid` left by a dead server is treated as stopped and
replaced on the next start. A stale lock is intentionally retained. Inspect `tmp/pg16.lock/owner`
and check that PID with `ps` and `kill -0`. Only after establishing that its owner no longer exists,
remove the owner file and empty lock directory, then run `pnpm pg:stop`. A missing owner file or
an uninspectable/live PID requires inspecting running script processes before removal. Never use
recursive deletion to bypass a busy command; ordinary reset does not reclaim a stale lock.

For an externally managed PostgreSQL 16 server, set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`
and `DB_DATABASE`, then run `DB_CLIENT=pg pnpm quick:test` (or `pnpm test` for lint and coverage).
The wrapper always targets its owned cluster. Packed-consumer checks provision separate databases;
these package checks do not satisfy their distinct validation gate.

### MySQL package tests

`pnpm test:mysql` runs the package suite against an external MySQL 8.4 server, with the Node
process in a non-UTC time zone (`America/New_York`) so a missed UTC conversion fails. Set
`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_DATABASE`; the defaults are
`127.0.0.1:33306`, `root`, no password and `account_kit_test`. The harness sets the session time
zone to UTC on every connection. A throwaway Homebrew server:

```sh
brew install mysql@8.4
"$(brew --prefix mysql@8.4)/bin/mysqld" --initialize-insecure --datadir=/tmp/ak-mysql
"$(brew --prefix mysql@8.4)/bin/mysqld" --datadir=/tmp/ak-mysql --port=33306 \
  --socket=/tmp/ak-mysql.sock --mysqlx=OFF &
"$(brew --prefix mysql@8.4)/bin/mysql" -uroot -h127.0.0.1 -P33306 -e 'create database account_kit_test'
pnpm test:mysql
```

The packed-consumer checks stay on SQLite and PostgreSQL; the MySQL evidence is this suite.

### Local service verification: 15 October 2026

These results were produced from uncommitted service/tooling changes on branch
`local-postgresql-tests`, based on `9776e938bbcb7c4c196b8bcbe0e2639e1dc7e206`. They are not
results for the clean base alone. The environment was macOS Bash 3.2, Node 24.21.0, pnpm 11.23.0
and PostgreSQL 16.15 (Homebrew), using the default managed port 55432.

The integrated commands passed: `bash -n bin/pg.sh`, the scoped Prettier check, `pnpm lint`,
`pnpm typecheck`, `pnpm build`, `DB_CLIENT=better-sqlite3 pnpm quick:test` (205 tests),
`pnpm test:pg-service` (60 tests), `pnpm test:pg` (205 tests) and
`DB_CLIENT=better-sqlite3 pnpm test:built-exports` (four tests).

Real-service checks also passed for repeated start/stop, preserving a standalone cluster,
refusing a different port without changing its server, reset with database creation, invocation
from `tests/`, hostile PG*/DB_* settings, a live non-PostgreSQL listener, missing binaries and
wrong-version reset recovery. A temporary failing Japa test produced exit 1 with 205 passing
tests and one deliberate failure; cleanup still completed. Selector forwarding selected only
`db.spec.ts`. A directly spawned wrapper interrupted with SIGINT exited 130, terminated the
runner's process group, stopped its server and removed its lock. Temporary tests and markers
were removed. Managed runs ended with status 3, no owned server and no lock. The regression
harness additionally covered TERM, repeated signals during cleanup, overlapping commands,
shutdown failures, stale locks and foreign process/path identities, including a directory name
that would otherwise make flattened process arguments ambiguous. A TERM-resistant descendant
exercised forced termination. The corrected service and real acceptance checks were rerun after
ownership hardening. `DB_PORT=055432` started and reused the real server on decimal port 55432;
both its PID file and SQL `show port` confirmed that value, followed by successful cleanup.
Linux executable/directory inspection and early unsupported-platform refusal have deterministic
fake-inspection regression coverage; real PostgreSQL service verification was on macOS only.

The package allowlist is unchanged and excludes the root service script, regression harness
and managed data/logs. The consumer matrix and hosted CI were not rerun for this tooling change;
their earlier evidence remains separate.

### Packed-consumer checks

The consumer harness writes an `evidence.json` record with the candidate revision, archive digest,
concrete dependency/database versions and each command outcome. A packed installation must
resolve its actual archive, with no repository-source link. The final candidate record accompanies
the pull request; historical development archives do not count as evidence for it.

The latest-compatible API fixture exercises fresh applications on both databases,
including all HTTP flows, required profile data, string/UUID IDs and a custom table, confirmations,
non-disclosing password reset responses, permission failures, scanner-safe inspection, token revocation,
and retryable outbox delivery. The exact-floor consumer independently typechecks the public
package API and exercises rollback, deferred commit failure, post-commit failure and concurrent
acceptance on both databases. See [compatibility](../compatibility.md) for the distinct dependency sets.

For a prebuilt immutable candidate, supply `--candidate-tarball=PATH --candidate-revision=REV`.
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
