# Lucid and Knex upgrades

The transaction implementation relies on more than the documented callback transaction API.
Review `src/transaction.ts` against the resolved versions of Lucid, Knex and the native driver
before changing those dependencies. Do not replace these mechanisms with a simpler call without
proving the same invariants.

| Dependency boundary                                                                      | Invariant                                                                                                                                             | Existing regression evidence                                                                                                                       |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knex `commit`, `executionPromise`, temporary `rollback` substitution                     | A rejected database COMMIT is a rollback, not a commit; Lucid's rollback lifecycle still runs. The original methods are restored.                     | [PostgreSQL deferred-constraint and password change failures](../../tests/transaction_postgres.spec.ts)                                            |
| SQLite native checkout, `inTransaction`, `busy_timeout`, `__knex__disposed`, and release | Acquire the writer before the callback, yield between busy retries, restore timeout and release cleanly; dispose an unclean connection.               | [SQLite writer progress, one-connection pool, commit contention, timeout restoration and rollback cleanup](../../tests/transaction_sqlite.spec.ts) |
| Lucid 22.4.2 transaction option versus 22.5 query-client `pinnedConnection`              | The native checkout is pinned to that transaction only; restore the query client's prior pin.                                                         | Same SQLite regression suite, at the minimum and latest supported peers                                                                            |
| Knex completion before Lucid commit listeners                                            | Never replay a committed callback; a follow-up fault is `PostCommitError`, not a rolled-back operation.                                               | [Committed timeout-restoration and busy-coded listener faults](../../tests/transaction_sqlite.spec.ts)                                             |
| Lucid 22.4.2 second-position transaction options                                         | MySQL must use READ COMMITTED and a UTC client, even on the minimum peer. Keep the workaround when later Lucid accepts options in the first position. | [Isolation and UTC tests](../../tests/transaction_isolation.spec.ts)                                                                               |

For each dependency upgrade:

1. Record the candidate revision, resolved Lucid, Knex and driver versions, and Node version in
   the PR evidence. Run the locked SQLite and PostgreSQL checks, including the tests above.
2. Run the `compat` workflow's `min-peers` and `latest-peers` lanes. They exercise PostgreSQL and
   the SQLite transaction regression suite at opposite ends of the declared peer support. For
   experimental MySQL support, run `pnpm test:mysql` with MySQL 8.4 in the documented UTC setup.
3. Build and pack the exact candidate, and run `pnpm test:consumer` for the SQLite and PostgreSQL
   consumer scenarios. Retain the candidate archive's SHA-256, revision, resolved dependency
   versions and `CONSUMER_EVIDENCE_PATH` JSON alongside the CI results.
4. Exercise the exact archive against separate checkouts of
   [Access Control](https://github.com/Kevinjohn/oss-adonisjs-access-control) (which consumes the
   transaction export) and [Password Confirmations](https://github.com/Kevinjohn/oss-adonisjs-confirm-action-with-password)
   (which performs confirmation work inside Account Kit's transaction). Keep each checkout's
   published peer range and baseline checks; record the exact consumer revision, candidate archive
   hash and resolved dependency versions. Do not silently update its peer declaration or publish
   an archive solely to run the tests.

Keep the dated findings and links to CI logs/consumer evidence with the upgrade PR, and add a
summary to the maintained verification record where useful. A passing locked test alone is not
floor/latest or cross-consumer evidence.
