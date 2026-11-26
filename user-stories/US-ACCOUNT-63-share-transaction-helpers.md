# US-ACCOUNT-63 — Share transaction and timestamp helpers

As a package consumer, I want to use Account Kit’s transaction helpers so that my database integration shares its locking and timestamp conventions.

**Status:** Current

**Access:** Application-owned database integration.

**Entry:** `@kevinjohn/adonisjs-account-kit/transaction`

**Documentation:** [Transaction helpers](../docs/guide/application-owned-integration.md#transaction-helpers-for-packages-built-on-account-kit)

**Source:** [transaction/main.ts](../transaction/main.ts), [src/transaction_manager.ts](../src/transaction_manager.ts)

**Coverage:** [tests/transaction_export.spec.ts](../tests/transaction_export.spec.ts), [tests/transaction_sqlite.spec.ts](../tests/transaction_sqlite.spec.ts)

## Acceptance criteria

- Construct `new TransactionManager(db)` and call `manager.run(callback)` with the supplied client for database operations. `manager.lockRow(trx, table, id)` uses a row lock on PostgreSQL and MySQL; on SQLite the transaction already holds the writer lock. Use `sqlTimestamp` and `readTimestamp` to round-trip the stored value. Successful commit returns the callback result.
- SQLite requires its migrated singleton lock row. Missing table or row aborts the transaction. A retryable SQLite busy failure before commit can rerun the database-only callback. A post-commit fault reports the committed write, so the caller must avoid replaying it.

## User flow

```mermaid
flowchart TD
    A["Consumer starts database operation"] --> B{"Transaction commits successfully?"}
    B -->|Yes| C["Receive callback result"]
    B -->|No| D["Inspect failure and committed state"]
```

## Code flow

```mermaid
flowchart TD
    A["TransactionManager.run(callback) delegates to transaction(db, callback)"] --> N{"Nested or already transactional connection?"}
    N -->|Yes| X["Reject before calling callback"]
    N -->|No| S{"SQLite?"}
    S -->|Yes| L["Acquire database writer via migrated singleton; bounded busy retries"]
    S -->|No| T["Begin transaction"]
    L --> R["Run database-only callback with trx"]
    T --> R
    R --> B{"Commit reached?"}
    B -->|No| D["Roll back pre-commit writes"]
    D --> K{"Retryable SQLite busy before deadline?"}
    K -->|Yes| L
    K -->|No| U["Propagate pre-commit failure"]
    B -->|Yes| F{"Committed cleanup or listener failure?"}
    F -->|No| C["Return callback result"]
    F -->|Yes| E["Report E_ACCOUNT_KIT_POST_COMMIT; do not replay committed write"]
```

**Code references:** [public manager](../src/transaction_manager.ts), [transaction](../src/transaction.ts), [lockRow](../src/user_lock.ts), [timestamp helpers](../src/timestamps.ts)
