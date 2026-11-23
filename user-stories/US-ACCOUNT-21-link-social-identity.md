# US-ACCOUNT-21 — Link a social identity

As a signed-in account holder, I want to link a provider identity after recent proof so that I can add an alternative sign-in for this account.

**Status:** Current when `socialAuthentication` is enabled
**Access:** An authenticated current and active account plus one-use recent `social_link` proof; provider state is bound to account and intent.
**Entry:** Host calls `socialAuthentication.begin` with intent `link` or posts to managed `auth.oauth.redirect`. Managed session clients use the GET callback. Access-token clients forward the provider response to `auth.oauth.complete` with intent `link` and the current bearer.
**Documentation:** [Social authentication](../docs/guide/social-authentication.md#linking-and-sensitive-actions-require-recent-proof) and [managed endpoints](../docs/guide/managed-social.md#endpoints)
**Source:** [`src/social_identity.ts`](../src/social_identity.ts), [`src/social_callback.ts`](../src/social_callback.ts)
**Coverage:** [`tests/social_identity_link.spec.ts`](../tests/social_identity_link.spec.ts)

## Acceptance criteria

- **Service inputs:** `socialAuthentication.begin({ provider, intent: 'link', current, clientChallenge, proof? })` returns state and URL for the current active account; optional proof is shape-checked and bound to that state. At callback, pass `{ state, callback, current, proof? }`: a state-bound proof may be omitted there, while proof may instead be supplied at callback. A state-bound proof takes precedence. Obtain a one-use proof via [US-ACCOUNT-23](US-ACCOUNT-23-prove-social-action.md). Callback state/proof consumption, active-account and provider-uniqueness checks, optional `acceptLink`, and insertion share one transaction; refusal before commit rolls back consumption. The optional `acceptLink(user, profile)` receives the locked account and `{ provider, subject, email, emailVerified }` and may throw to refuse.
- **Managed inputs and results:** Supply proof at begin. The session strategy makes the challenge and saves the intent server-side. Access-token clients supply a challenge and forward `state`, provider `code` and `intent: 'link'` with the selected bearer. Managed callbacks return 200 `{ status: 'linked' }`; the service also returns `userId`. A failed follow-up to a committed link can give 202 `{ committed: true }` on managed routes. Refresh the linked list to reconcile.

## User flow

```mermaid
flowchart TD
 A["Signed-in person starts provider linking with recent proof"] --> B{"Is the signed-in account active?"}
 B -->|No| C["Refuse before provider state is stored"]
 B -->|Yes| D["Provider callback is bound to account, intent and challenge"]
 D --> E{"Is state-bound or callback-supplied social_link proof valid?"}
 E -->|No| F["Refuse link; transaction rolls back"]
 E -->|Yes| G{"Is account active and provider subject unused?"}
 G -->|No| H["Refuse link; transaction rolls back proof and state consumption"]
 G -->|Yes| I{"Does optional acceptLink refuse?"}
 I -->|Yes| J["Callback throws; transaction rolls back"]
 I -->|No| K["Link the identity; send notice if the account address is confirmed"]
 K -->|Follow-up failure| R["Refresh linked identities to reconcile the committed link"]
```

## Code flow

Scope: host and managed inputs through linking and delivery.

```mermaid
flowchart TD
 A["Host calls begin with intent link, current, clientChallenge and optional proof"] --> C
 M["auth.oauth.redirect validates link input, reads guard.current and prepares a challenge"] --> C
 C["begin validates current and active state; stores provider state and optional proof hash"] -->|Refusal| E["Reject before storing state"]
 C --> U["Return provider URL; managed begin saves intent and verifier for session clients"]
 U --> S{"Callback caller?"}
 S -->|Host| H["Call callback with current and optional proof"]
 S -->|Managed session GET| MG["Read saved link intent and selected guard current input"]
 S -->|Managed token POST| MT["Read forwarded link intent and selected bearer current input"]
 H --> B
 MG --> B
 MT --> B
 B["socialCallback checks candidate state and resolves provider profile"] --> T["Lock account; consume state; bind and validate current actor"]
 T --> P["Consume state-bound or host-supplied proof; check active account and unique provider subject"]
 P --> L["Run optional acceptLink and insert confirmed relation"]
 B -->|Provider or state refusal| X["Propagate callback refusal"]
 T -->|Refusal| R["Roll back state and proof consumption"]
 P -->|Refusal| R
 L -->|Refusal| R
 L --> F["Commit, then notify if the account has a confirmed address"]
 F -->|Success| O["Return linked and userId to host; managed JSON returns status only"]
 F -->|Follow-up fault| Y["Committed failure in service; managed JSON returns 202 committed"]
```

**Code references:** [begin and callback API](../src/social_identity.ts), [callback checks](../src/social_callback.ts), [managed provider handlers](../src/http/social.ts), [managed responses](../src/http/managed.ts), [link tests](../tests/social_identity_link.spec.ts)
