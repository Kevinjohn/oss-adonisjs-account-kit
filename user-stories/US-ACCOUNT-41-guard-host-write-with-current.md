# US-ACCOUNT-41 — Commit a host write with a tracked current sign-in

As an application developer, I want a host-owned write to share Account Kit's current-credential transaction so that a tracked credential revocation cannot race that write.

**Status:** Current when authentication is configured
**Access:** Host authenticates and authorises the account before passing its `CurrentAccountInput`; the callback must use the supplied transaction for every write.
**Entry:** Host calls `authentication.withCurrent(current, async ({ account, signInId, trx, readCredentialRevision }) => ...)`.
**Documentation:** [Protected requests](../docs/guide/authentication.md#protected-requests)
**Source:** [`src/authentication.ts`](../src/authentication.ts)
**Coverage:** [`tests/session_management.spec.ts`](../tests/session_management.spec.ts), [`tests/authentication.spec.ts`](../tests/authentication.spec.ts)

## Acceptance criteria

- `withCurrent` returns the callback result. It checks the current account and credential, then runs the callback under the same transaction. For non-SQLite databases it rechecks and locks the token or tracked-session row before the callback, refusing if it has disappeared; `signInId` is present only for a tracked session sign-in. SQLite serialises writers instead of locking a sign-in row. With session management disabled there is no registry row to lock. The callback can call `readCredentialRevision()` to read the live revision in the same transaction.
- A callback error rolls back Kit and callback writes. Keep callback work database-only and retry-safe, and acquire host row locks inside the callback. Where a tracked sign-in row is locked, concurrent logout/token deletion waits for this transaction; do not assume a universal logout-wait guarantee for untracked sessions or every database.

- After a transaction has committed, a follow-up failure can be reported as a committed fault. Reconcile the persisted state before deciding how to recover. See the [transaction engine](../src/transaction.ts) and [transaction tests](../tests/transaction.spec.ts).

## User flow

```mermaid
flowchart TD
 A["Host begins account-scoped write"] --> B{"Is the current sign-in still valid?"}
 B -->|No| C["Refuse before host write"]
 B -->|Yes| D["Lock sign-in row when supported and present; run host write in supplied transaction"]
 D --> E{"Does the write transaction commit?"}
 E -->|No| F["Roll back the transaction and return the error"]
 E -->|Yes| G["Commit account-scoped result"]
 G -->|Follow-up fault| Y["Reconcile committed change before recovery"]
```

## Code flow

Scope: the callback executes inside the Account Kit transaction and uses its `trx`. See [US-ACCOUNT-39](US-ACCOUNT-39-current-account.md) for shared account and sign-in checks.

```mermaid
flowchart TD
 A["authentication.withCurrent(current, run)"] --> B["requireCurrentAccountAndSession validates account and can touch a tracked session"]
 B -->|Validation failure| V0["Propagate current-account error before callback"]
 B --> C{"Non-SQLite and token or tracked-session ID available?"}
 C -->|Yes| D["Lock token or tracked session row"]
 D --> V{"Row still present?"}
 V -->|No| X["Throw InvalidSessionError before callback"]
 C -->|No| E["Continue under transaction/account lock; SQLite serialises writers"]
 V -->|Yes| F["Invoke run({ account, signInId?, trx, readCredentialRevision })"]
 E --> F
 F --> G{"Callback resolves?"}
 G -->|No| H["Roll back; preserve the callback error and report any rollback failure"]
 G -->|Yes| I["Attempt commit"]
 I -->|Success| U["Return callback result"]
 I -->|Pre-commit fault| H
 I -->|Committed fault| J["Report fault without replay"]
```

**Code references:** [`withCurrent` and `lockSignIn`](../src/authentication.ts), [transaction engine](../src/transaction.ts), [`protected requests guide`](../docs/guide/authentication.md#protected-requests)
