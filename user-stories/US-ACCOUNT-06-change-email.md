# US-ACCOUNT-06 — Change and confirm the account email

As a signed-in account holder, I want to request a new email and confirm ownership so that I can keep the old address active until the new one is proven.

**Status:** Current when `emailPasswordManagement` is enabled
**Access:** Authenticated current account; new address must pass uniqueness and confirmation checks.
**Entry:** Host calls `requestEmailChange`, then the recipient follows the confirmation link consumed by `emailPasswordManagement.completeEmailChange`; optional managed profile route.
**Documentation:** [account-operations.md](../docs/guide/account-operations.md)
**Source:** [`src/profile_update.ts`](../src/profile_update.ts)
**Coverage:** [`tests/credentials_email_change_completion.spec.ts`](../tests/credentials_email_change_completion.spec.ts)

## Acceptance criteria

- **Inputs and result:** `emailPasswordManagement.requestEmailChange({ actorId, newEmail, currentPassword? , recentProof? })` returns `void`; password accounts prove the current password, social-only accounts use purpose-bound proof. `emailPasswordManagement.inspectEmailChange({ token })` is read-only; `completeEmailChange({ token })` returns the updated account.

## User flow

```mermaid
flowchart TD
 A["Signed-in person requests a new email"] --> B{"Does address pass shape, uniqueness and current-identity proof?"}
 B -->|No| C["Keep the current email and show refusal"]
 B -->|Yes| D["Send confirmation to the new address; keep old address active"]
 D --> E{"Is the confirmation token still usable?"}
 E -->|No| F["Keep old address; ask for a fresh request"]
 E -->|Yes| G["Switch email and invalidate affected older credentials"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["emailPasswordManagement.requestEmailChange"] --> B["updateProfile validates email and maps configured fields"]
 B --> C["Transaction confirms actor proof and stores pending address/token"]
 C --> D["Commit and send email-change provision"]
 E["emailPasswordManagement.completeEmailChange({ token })"] --> F["Consume proof, replace email and update credential revision transactionally"]
 F --> G["Commit and run old/new address notices"]
```

**Code references:** [implementation](../src/profile_update.ts), [`tests/credentials_email_change_completion.spec.ts`](../tests/credentials_email_change_completion.spec.ts)
