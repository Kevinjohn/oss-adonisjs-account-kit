# US-ACCOUNT-21 — Link a social identity

As a signed-in account holder, I want to link a provider identity after recent proof so that I can add an alternative sign-in for this account.

**Status:** Current when social authentication is configured
**Access:** Authenticated current, active account with confirmed email plus one-use recent `social_link` proof; provider state is bound to account and intent.
**Entry:** Host begins a provider flow with intent `link`; callback is handled by host/managed route, which may provide `social_link` proof at callback time.
**Documentation:** [social-authentication.md](../docs/guide/social-authentication.md)
**Source:** [`src/social_identity.ts`](../src/social_identity.ts), [`src/social_callback.ts`](../src/social_callback.ts)
**Coverage:** [`tests/social_identity_link.spec.ts`](../tests/social_identity_link.spec.ts)

## Acceptance criteria

- **Inputs and result:** `socialAuthentication.begin({ provider, intent: 'link', current, clientChallenge, proof? })` returns state and URL for the current active account with confirmed email; optional proof is shape-checked and bound to that state. At callback, pass `{ state, callback, current, proof? }`: a state-bound proof may be omitted there, while proof may instead be supplied at callback. Password accounts obtain one-use `social_link` proof with `provePassword({ current, password, purpose: social_link })`. Callback state/proof consumption, active-account and provider-uniqueness checks, optional `acceptLink`, and insertion share one transaction; refusal before commit rolls back consumption.

## User flow

```mermaid
flowchart TD
 A["Signed-in person starts provider linking with current credential and challenge"] --> B{"Is account active with confirmed email?"}
 B -->|No| C["Refuse before provider state is stored"]
 B -->|Yes| D["Provider callback is bound to account, intent and challenge"]
 D --> E{"Is state-bound or callback-supplied social_link proof valid?"}
 E -->|No| F["Refuse link; transaction rolls back"]
 E -->|Yes| G{"Is account active and provider subject unused?"}
 G -->|No| H["Refuse link; transaction rolls back proof and state consumption"]
 G -->|Yes| I{"Does optional acceptLink refuse?"}
 I -->|Yes| J["Refuse link; transaction rolls back"]
 I -->|No| K["Insert identity and commit; notify after commit"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["socialAuthentication.begin(intent = link) checks current account and optional proof shape"] --> B{"Does begin find an active account with confirmed email?"}
 B -->|No| C["Refuse before storing provider state"]
 B -->|Yes| D["Store one-use state with account and optional proof hash"]
 D --> E["Provider returns callback"]
 E --> F["socialAuthentication.callback resolves provider profile, then begins transaction"]
 F --> G["Within the transaction: consume state, recheck current actor, consume proof, check active status, then check provider uniqueness"]
 G --> H{"Do the ordered transaction checks pass?"}
 H -->|No| I["Refuse link; roll back state and proof consumption"]
 H -->|Yes| J["Run configured acceptLink callback, if present"]
 J --> K{"Did the optional callback refuse?"}
 K -->|Yes| L["Refuse link; roll back transaction"]
 K -->|No| M["Insert social identity and commit"]
 M --> N["Run linked notification after commit"]
```

**Code references:** [begin and callback API](../src/social_identity.ts), [callback proof handling](../src/social_callback.ts), [`tests/social_identity_link.spec.ts`](../tests/social_identity_link.spec.ts)
