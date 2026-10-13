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

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

Implementation follows `PLAN.md`. The working package name will be settled before publication.
