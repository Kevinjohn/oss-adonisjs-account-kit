# US-ACCOUNT-06 — Change and confirm the account email

As a signed-in account holder, I want to request a new email and confirm ownership so that I can keep the old address active until the new one is proven.

**Status:** Current when `emailPasswordManagement` is enabled
**Access:** Authenticated current account; new address must pass uniqueness and confirmation checks.
**Entry:** Host calls `requestEmailChange`, then the recipient follows the confirmation link consumed by `emailPasswordManagement.completeEmailChange`; optional managed profile route.
**Documentation:** [account-operations.md](../docs/guide/account-operations.md)
**Source:** [`src/profile_update.ts`](../src/profile_update.ts), [email proof completion](../src/email_change.ts)
**Coverage:** [`tests/credentials_email_change_completion.spec.ts`](../tests/credentials_email_change_completion.spec.ts)

## Acceptance criteria

- **Inputs and result:** `emailPasswordManagement.requestEmailChange({ actorId, newEmail, currentPassword? , recentProof? })` returns `void`; password accounts prove the current password, social-only accounts use purpose-bound proof. `emailPasswordManagement.inspectEmailChange({ token })` is read-only; `completeEmailChange({ token })` returns the updated account.

- For an active account requesting a different address, keep the confirmed address until completion. Requesting the confirmed address cancels an existing pending change; a repeat for the same pending address within one minute does not send again.
- For an inactive account, requesting a different address changes both address fields and issues an activation link; it stays inactive until activation with a policy-valid password. This branch advances credentials immediately.
- Delivery happens after commit; a delivery failure leaves the saved address state in place and is surfaced to the caller.

## User flow

```mermaid
flowchart TD
 A["Signed-in person requests a new email"] --> B{"Does address pass shape, uniqueness and current-identity proof?"}
 B -->|No| C["Keep the current email and show refusal"]
 B -->|Yes| S{"Account/address state?"}
 S -->|Same confirmed address| T["Cancel pending change; no new link"]
 S -->|Same pending address in cooldown| V["Keep pending link; no new delivery"]
 S -->|Inactive account, different address| W["Replace unconfirmed address; issue activation link"]
 S -->|Active account, different address| D["Issue confirmation; keep old address active"]
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
 C --> D["Commit; issue activation provision for inactive account or email-change provision for active account when needed"]
 E["emailPasswordManagement.completeEmailChange({ token })"] --> F["Consume proof, replace email and update credential revision transactionally"]
 F --> G["Commit and run old/new address notices"]
```

**Code references:** [request implementation](../src/profile_update.ts), [completion and inspection](../src/email_change.ts), [`tests/credentials_email_change_completion.spec.ts`](../tests/credentials_email_change_completion.spec.ts)
