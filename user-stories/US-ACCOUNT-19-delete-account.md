# US-ACCOUNT-19 — Delete an account

As an account holder, I want to close the account after proving identity so that I can remove package-owned records and invoke host cleanup atomically.

**Status:** Current when `accountDeletion` is enabled
**Access:** Recent proof required; host defines and implements deletion callback for application-owned rows/retention.
**Entry:** Host-owned endpoint calls `accountData.delete`; managed deletion route is optional.
**Documentation:** [account-data.md](../docs/guide/account-data.md)
**Source:** [`src/account_deletion.ts`](../src/account_deletion.ts)
**Coverage:** [`tests/account_deletion.spec.ts`](../tests/account_deletion.spec.ts)

## Acceptance criteria

- **Inputs and result:** `accountData.delete({ actorId, currentPassword? , recentProof? })` returns `void`. Password accounts prove the current password; password-less accounts use purpose-bound `account_delete` proof. The configured transaction callback handles application-owned rows before package/user deletion.

## User flow

```mermaid
flowchart TD
 A["Account holder confirms deletion and proves identity"] --> B{"Does current password or account_delete proof pass?"}
 B -->|No| C["Refuse; user and data remain"]
 B -->|Yes| D["Run host cleanup and remove package rows and user in one transaction"]
 D --> E["After commit send deletion notice; delivery failure does not restore account"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["accountData.delete"] --> B["Throttle and transactionally confirm actor"]
 B --> C{"Proof and delete adapter available?"}
 C -->|No| D["Abort transaction; user remains"]
 C -->|Yes| E["Run onAccountDeletingTransaction, delete package rows, then user row"]
 E --> F["Commit deletion"]
 F --> G["Send notice and lifecycle event; report follow-up error without rollback"]
```

**Code references:** [implementation](../src/account_deletion.ts), [`tests/account_deletion.spec.ts`](../tests/account_deletion.spec.ts)
