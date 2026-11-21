# US-ACCOUNT-63 — Share transaction and timestamp helpers

As a package consumer, I want to use Account Kit’s transaction helpers so that my database integration shares its locking and timestamp conventions.

**Status:** Current

**Access:** Application-owned database integration.

**Entry:** `@kevinjohn/adonisjs-account-kit/transaction`

**Documentation:** [Guide](../docs/guide/core-api.md)

**Source:** [transaction/main.ts](../transaction/main.ts), [src/transaction.ts](../src/transaction.ts)

**Coverage:** [tests/transaction_export.spec.ts](../tests/transaction_export.spec.ts)

## Acceptance criteria

- Use transaction and the supplied client for database operations. Use lockRow for row locking and sqlTimestamp and readTimestamp to round-trip the stored value. Successful commit returns the callback result.
- SQLite requires its migrated singleton lock row. Missing table or row aborts the transaction. A post-commit fault reports the committed write, so the caller must avoid replaying it.

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
    A["Open transaction and supply client"] --> B{"Callback and commit complete?"}
    B -->|Yes| C["Return callback result"]
    B -->|No| D["Handle rollback or committed fault"]
```
