# US-ACCOUNT-19 — Delete an account

As an account holder, I want to close the account after proving identity so that I can remove package-owned records and invoke host cleanup atomically.

**Status:** Current when `accountDeletion` is enabled
**Access:** Current password required for password accounts, or purpose-bound `account_delete` recent proof for password-less accounts, which also requires `socialAuthentication` to be enabled (otherwise `NoPasswordError`); host defines and implements deletion callback for application-owned rows/retention.
**Entry:** Host-owned endpoint calls `accountData.delete`; managed deletion route is optional.
**Documentation:** [account-data.md](../docs/guide/account-data.md)
**Source:** [`src/account_deletion.ts`](../src/account_deletion.ts)
**Coverage:** [`tests/account_deletion.spec.ts`](../tests/account_deletion.spec.ts)

## Acceptance criteria

- **Inputs and result:** `accountData.delete({ actorId, currentPassword? , recentProof? })` returns `void`. Password accounts prove the current password; password-less accounts use purpose-bound `account_delete` proof and need `socialAuthentication` enabled; without it they are refused with `NoPasswordError`, even when a proof is supplied. The configured transaction callback handles application-owned rows before package/user deletion.

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
 A["accountData.delete"] --> B{"users.delete adapter method available?"}
 B -->|No| D0["Throw before the throttle is spent; user remains"]
 B -->|Yes| T["Consume identity:user throttle budget"]
 T --> C["Transaction locks actor and confirmActor checks password or account_delete proof"]
 C --> P{"Proof accepted?"}
 P -->|No| D["Abort transaction; user remains"]
 P -->|Yes| E["Run onAccountDeletingTransaction, delete package rows, then user row"]
 E --> F["Commit deletion"]
 F --> G["Send notice and lifecycle event; report follow-up error without rollback"]
```

**Code references:** [implementation](../src/account_deletion.ts), [`confirmActor`](../src/actor_confirmation.ts), [`tests/account_deletion.spec.ts`](../tests/account_deletion.spec.ts)
