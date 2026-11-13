# US-ACCOUNT-22 — Unlink a social identity

As a signed-in account holder, I want to remove a linked provider identity so that I can stop that provider from authenticating this account.

**Status:** Current when social authentication is configured
**Access:** Authenticated current account and one-use `social_unlink` proof; the package refuses to remove the last usable sign-in method.
**Entry:** Host calls `socialAuthentication.unlink({ current, identityId, proof })`; no built-in identity settings screen.
**Documentation:** [social-authentication.md](../docs/guide/social-authentication.md)
**Source:** [`src/social_identity.ts`](../src/social_identity.ts)
**Coverage:** [`tests/social_identity_unlink.spec.ts`](../tests/social_identity_unlink.spec.ts)

## Acceptance criteria

- **Inputs and result:** `socialAuthentication.unlink({ current, identityId, proof })` returns `void`. `proof` must be a one-use `social_unlink` proof. The package prevents removing the account’s last sign-in method and invalidates older credentials on a successful unlink.

## User flow

```mermaid
flowchart TD
 A["Account holder chooses one linked identity and submits social_unlink proof"] --> B{"Does proof validate and does identity belong to this account?"}
 B -->|No| C["Refuse without changing identities"]
 B -->|Yes| D{"Would another sign-in method remain?"}
 D -->|No| E["Refuse removal of the last sign-in method"]
 D -->|Yes| F["Remove identity and end older credentials"]
 F --> G["Notify after commit"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["socialAuthentication.unlink({ current, identityId, proof })"] --> B["Check current credential, purpose-bound proof and ownership"]
 B --> C["Transaction enforces at least one remaining sign-in method"]
 C --> D{"All unlink invariants pass?"}
 D -->|No| E["Abort transaction before unlink"]
 D -->|Yes| F["Delete relationship and advance credential state"]
 F --> G["Commit, then notify; follow-up failure does not restore identity"]
```

**Code references:** [implementation](../src/social_identity.ts), [`tests/social_identity_unlink.spec.ts`](../tests/social_identity_unlink.spec.ts)
