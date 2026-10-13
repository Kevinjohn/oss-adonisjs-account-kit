# adonisjs-account-kit

Account recovery, email verification, invitations and credential changes for AdonisJS 7.

Development requires Node 24 or newer and pnpm.

Tests use SQLite by default and need no database service. SQLite is stored in a temporary file
with WAL enabled so tests can use separate connections. To run the suite against PostgreSQL,
start a local PostgreSQL 16 database and set `DB_CLIENT=pg` plus the connection variables below.
The defaults match the repository's local PostgreSQL test service.

| Variable      | Default            | Purpose                         |
| ------------- | ------------------ | ------------------------------- |
| `DB_CLIENT`   | `better-sqlite3`   | Select `better-sqlite3` or `pg` |
| `DB_HOST`     | `127.0.0.1`        | PostgreSQL host                 |
| `DB_PORT`     | `55432`            | PostgreSQL port                 |
| `DB_USER`     | `account_kit`      | PostgreSQL user                 |
| `DB_PASSWORD` | empty              | PostgreSQL password             |
| `DB_DATABASE` | `account_kit_test` | PostgreSQL database             |

For example, `DB_CLIENT=pg pnpm test` runs the same tests against PostgreSQL.

The test users adapter stores normalized email addresses in a unique `email` column and hashes
passwords through the booted application's hash service. Its transaction-aware methods use the
supplied Lucid transaction. SQLite tests use WAL with a four-connection pool and a per-connection
busy timeout of 5 seconds.

Database-only work can use the internal `transaction(db, callback)` helper. The callback may be
re-run after a SQLite busy error, so it must contain only transaction-bound database work;
notifications and other side effects belong after the helper resolves. On SQLite, the helper
temporarily disables the connection's blocking busy timeout, rolls back a busy attempt, waits
asynchronously and retries the whole callback for up to 5 seconds. PostgreSQL uses Lucid's
managed transaction directly.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

Implementation follows `PLAN.md`. The working package name will be settled before publication.
