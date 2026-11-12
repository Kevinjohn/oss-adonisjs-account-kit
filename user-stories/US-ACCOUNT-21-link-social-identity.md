# US-ACCOUNT-21 — Link a social identity

As a signed-in account holder, I want to link a provider identity after recent proof so that I can add an alternative sign-in for this account.

**Status:** Current when social authentication is configured
**Access:** Authenticated current account plus one-use recent `social_link` proof; provider state is bound to account and intent.
**Entry:** Host calls `provePassword` when applicable and begins a provider flow with intent `link`; callback is handled by host/managed route.
**Documentation:** [social-authentication.md](../docs/guide/social-authentication.md)
**Source:** [`src/social_identity.ts`](../src/social_identity.ts)
**Coverage:** [`tests/social_identity_link.spec.ts`](../tests/social_identity_link.spec.ts)

## Acceptance criteria

- **Inputs and result:** `socialAuthentication.begin({ provider, intent: 'link', current, clientChallenge, proof })` returns state and URL; callback consumes the bound proof and returns its social outcome. Password accounts first obtain one-use `social_link` proof with `provePassword({ current, password, purpose: social_link })`.

## User flow

```mermaid
flowchart TD
 A["Signed-in person proves identity and starts provider linking"] --> B{"Is current credential and social_link proof valid?"}
 B -->|No| C["Refuse link; no provider identity is added"]
 B -->|Yes| D["Provider callback is bound to account, intent and challenge"]
 D --> E{"Does host accept this provider identity and is it unused?"}
 E -->|No| F["Keep identity relationships unchanged"]
 E -->|Yes| G["Link identity and notify after commit"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["socialAuthentication.provePassword when password exists"] --> B["Issue purpose-bound social_link proof"]
 B --> C["socialAuthentication.begin(intent = link) stores account/proof-bound state"]
 C --> D["callback consumes state and proof; acceptLink runs in transaction"]
 D --> E{"Provider subject passes checks?"}
 E -->|No| F["Abort relationship write"]
 E -->|Yes| G["Insert social identity; commit and run linked notification"]
```

**Code references:** [implementation](../src/social_identity.ts), [`tests/social_identity_link.spec.ts`](../tests/social_identity_link.spec.ts)
