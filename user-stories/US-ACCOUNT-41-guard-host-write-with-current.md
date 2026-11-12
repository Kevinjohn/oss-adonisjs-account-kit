# US-ACCOUNT-41 — Commit a host write only for the current sign-in

As an application developer, I want a host-owned write to share Account Kit's current-credential transaction so that logout or credential revocation cannot race that write.

**Status:** Current when authentication is configured
**Access:** Host authenticates and authorizes the account before passing its `CurrentAccountInput`; the callback must use the supplied transaction for every write.
**Entry:** Host calls `authentication.withCurrent(current, async ({ account, signInId, trx }) => ...)`.
**Documentation:** [Protected requests](../docs/guide/authentication.md#protected-requests)
**Source:** [`src/authentication.ts`](../src/authentication.ts)
**Coverage:** [`tests/session_management.spec.ts`](../tests/session_management.spec.ts), [`tests/authentication.spec.ts`](../tests/authentication.spec.ts)

## Acceptance criteria

- `withCurrent` returns the callback result. It checks current account and credential, locks the sign-in row when one exists, then runs the callback under that transaction; `signInId` is present only for a tracked session sign-in.
- A callback error rolls back Kit and callback writes. Callback work must be database-only and retry-safe; a concurrent logout waits for the callback transaction's sign-in lock.

## User flow

```mermaid
flowchart TD
 A["Host begins account-scoped write"] --> B{"Does current credential still validate?"}
 B -->|No| C["Refuse before host write"]
 B -->|Yes| D["Lock matching sign-in and run host write in supplied transaction"]
 D --> E{"Does callback succeed?"}
 E -->|No| F["Roll back both writes and return callback error"]
 E -->|Yes| G["Commit account-scoped result"]
```

## Code flow

Scope: callback executes inside the Account Kit transaction and must use its `trx`.

```mermaid
flowchart TD
 A["authentication.withCurrent(current, run)"] --> B["currentWithSessionInTransaction validates account/revision"]
 B --> C["lockSignIn locks tracked session row when present"]
 C --> D["Invoke run({ account, signInId?, trx })"]
 D --> E{"Callback resolves?"}
 E -->|No| F["Transaction rolls back and error propagates unchanged"]
 E -->|Yes| G["Commit and return callback result"]
```

**Code references:** [`withCurrent` and `lockSignIn`](../src/authentication.ts), [`protected requests guide`](../docs/guide/authentication.md#protected-requests)
