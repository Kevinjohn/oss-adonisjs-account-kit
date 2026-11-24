# US-ACCOUNT-06 — Change and confirm the account email

As a signed-in account holder, I want to request a new email and confirm ownership so that I can keep the old address active until the new one is proven.

**Status:** Current when `emailPasswordManagement` is enabled
**Access:** Authenticated current account; new address must pass uniqueness and confirmation checks.
**Entry:** Host calls `emailPasswordManagement.requestEmailChange`, or uses managed PATCH `account/profile` with `email`. Active-account confirmation uses the public GET/POST `auth/email-change/:token` managed routes or the equivalent service calls. Inactive-account correction leads to [verification](US-ACCOUNT-38-complete-email-verification.md).
**Documentation:** [account-operations.md](../docs/guide/account-operations.md)
**Source:** [`src/profile_update.ts`](../src/profile_update.ts), [email proof completion](../src/email_change.ts)
**Coverage:** [`tests/credentials_email_change_completion.spec.ts`](../tests/credentials_email_change_completion.spec.ts)

## Acceptance criteria

- **Inputs and result:** `emailPasswordManagement.requestEmailChange({ actorId, newEmail, currentPassword?, recentProof? })` returns `void`; password accounts prove the current password, password-less accounts use `email_change` proof when `socialAuthentication` is enabled. `emailPasswordManagement.inspectEmailChange({ token })` is read-only; `completeEmailChange({ token })` returns the updated account.

- For an active account requesting a different address, keep the confirmed address until completion. Requesting the confirmed address cancels an existing pending change; a repeat for the same pending address within one minute reuses a live matching email-change proof without another delivery.
- For an inactive account, requesting a different address changes both address fields and issues an activation link; it stays inactive until activation with a policy-valid password. This branch advances credentials immediately.
- Completion calls the configured `emailChanged(previousEmail, user)` callback; the built-in mail helper sends this completion notice to the previous address. New-address confirmation is a separate request provision. Delivery happens after commit. If the new-address provision fails, the service attempts to reopen the cooldown and the saved address state remains in place.
- The managed profile handler preserves its current credential on inactive-account correction, refreshing a session from the committed revision. Managed email-change inspection returns `{ valid: true }` or an invalid-proof response. Completion returns 200 with the represented account.
- If the managed write recognises a committed follow-up failure, it returns 202 with `{ committed: true }`.

## User flow

```mermaid
flowchart TD
 A["Signed-in person requests a new email"] --> B{"Does address pass shape, uniqueness and current-identity proof?"}
 B -->|No| C["Keep the current email and show refusal"]
 B -->|Yes| S{"Account/address state?"}
 S -->|Same confirmed address| T["Cancel pending change; no new link"]
 S -->|Same pending email change in cooldown| V["Keep pending link; no new delivery"]
 S -->|Inactive account, different address| W["Replace unconfirmed address; issue activation link"]
 W --> W2["Follow activation link to confirm the address"]
 S -->|Active account, different address| D["Issue confirmation; keep old address active"]
 D --> E{"Is the confirmation token still usable?"}
 E -->|No| F["Keep old address; ask for a fresh request"]
 E -->|Yes| G["Submit confirmation"]
 G -->|Address no longer available| F
 G -->|Success| X["Switch email and invalidate older credentials"]
```

## Code flow

```mermaid
flowchart TD
  A["requestEmailChange forwards newEmail as email; managed profile handler calls updateProfile with keepCurrent"] --> B["updateProfile validates email, maps fields if supplied and throttles actor"]
  B --> C["Transaction confirms actor for email_change and persists mapped profile fields, if any"]
  C --> I{"Email state?"}
  I -->|Same current address| J["Clear pending different address and verification proof, if present; return without new delivery"]
  I -->|Different and already registered| X["Roll back with E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED"]
  I -->|Same pending email change in cooldown| K["Keep existing proof; return without new delivery"]
  I -->|Inactive, different and available| L["Replace current and pending email, clear reset proof, upsert activation proof and advance credentials"]
  I -->|Active, different and available| M["Upsert pending address and email-change proof"]
  L --> D["Commit; run observer for correction, corresponding provision and lifecycle event"]
  M --> D
  D --> Z["Return saved result or committed follow-up failure; managed correction refreshes session revision when available"]
  Q["Managed inspection or direct inspectEmailChange"] --> T["Check live email_change proof and current/pending email match without consumption"]
  E["Managed completion or direct completeEmailChange"] --> F["Transaction consumes matching proof and checks new email still available"]
  F -->|Refused| X2["Roll back and surface invalid proof or email collision"]
  F -->|Accepted| G["Set and verify email, clear password reset proof, advance credentials and commit"]
  G --> O["Run credential observer, previous-address completion callback and lifecycle event; return account or committed error"]
```

**Code references:** [request implementation](../src/profile_update.ts), [completion and inspection](../src/email_change.ts), [`tests/credentials_email_change_completion.spec.ts`](../tests/credentials_email_change_completion.spec.ts), [managed profile and email change](../src/http/handlers_email_password_management.ts), [actor proof](../src/actor_confirmation.ts), [managed committed-failure response](../src/http/managed.ts)
