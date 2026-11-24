# US-ACCOUNT-22 — Unlink a social identity

As a signed-in account holder, I want to remove a linked provider identity so that I can stop that provider from authenticating this account.

**Status:** Current when `socialAuthentication` is enabled
**Access:** Authenticated current account and one-use `social_unlink` proof; the package refuses to remove the last usable sign-in method.
**Entry:** Host calls `socialAuthentication.unlink({ current, identityId, proof })`, or sends DELETE `account/social-identities/:id` to managed `account.socialIdentities.unlink`.
**Documentation:** [Social authentication](../docs/guide/social-authentication.md#linking-and-sensitive-actions-require-recent-proof) and [managed endpoints](../docs/guide/managed-social.md#endpoints)
**Source:** [`src/social_identity.ts`](../src/social_identity.ts)
**Coverage:** [`tests/social_identity_unlink.spec.ts`](../tests/social_identity_unlink.spec.ts)

## Acceptance criteria

- Choose an owned identity with numeric `identityId` and provide a one-use `social_unlink` proof. Managed DELETE requires a canonical positive safe-integer ID and non-empty `{ proof }` body, plus Shield CSRF for sessions.
- A password or another confirmed identity for an enabled provider must remain. If refused before commit, proof consumption rolls back. Success returns `void` or managed 204 and ends older credentials, including the credential used for the request. Sign in again with a remaining method.
- The credential observer runs after commit. Notification requires a confirmed relationship and confirmed account address. Follow-up failure preserves the unlink and can return managed 202 `{ committed: true }`.

## User flow

```mermaid
flowchart TD
 A["Account holder chooses one linked identity and submits social_unlink proof"] --> B{"Does proof validate and does identity belong to this account?"}
 B -->|No| C["Refuse without changing identities"]
 B -->|Yes| D{"Would another sign-in method remain?"}
 D -->|No| E["Refuse removal of the last sign-in method"]
 D -->|Yes| F["Remove identity and end older credentials"]
 F --> G["Sign in again with a remaining method"]
```

## Code flow

Scope: managed or host entry through unlink, invalidation and follow-ups.

```mermaid
flowchart TD
 H["Host calls socialAuthentication.unlink"] --> A
 M["Managed DELETE checks current account, validates proof and parses positive identity ID"] --> A
 A["unlinkSocialIdentity transaction validates current and finds owned identity"] --> P["Consume social_unlink proof and check remaining password or enabled confirmed provider"]
 P --> F["Delete identity and call invalidateChangedCredentials"]
 A -->|Refusal| E["Abort transaction and propagate error"]
 P -->|Refusal| E
 F -->|Pre-commit fault| E
 F --> C["Commit unlink and credential invalidation"]
 C --> O["Run observer and send notice for confirmed relationship and address"]
 O -->|Success| S["Service returns void; managed handler returns 204"]
 O -->|Committed fault| D["Service reports committed failure; managed route returns 202 committed"]
```

**Code references:** [service entry](../src/social_identity.ts), [unlink transaction](../src/social_links.ts), [credential invalidation](../src/credential_revision.ts), [managed execution](../src/http/managed_execution.ts), [managed handlers](../src/http/managed_social_account_handlers.ts), [managed responses](../src/http/managed.ts), [unlink tests](../tests/social_identity_unlink.spec.ts)
