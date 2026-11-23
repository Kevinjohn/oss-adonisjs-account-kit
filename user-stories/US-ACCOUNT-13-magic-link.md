# US-ACCOUNT-13 — Sign in with an email link

As an existing account holder, I want to request and complete an opt-in passwordless sign-in link so that I can sign in without entering a password.

**Status:** Current when `magicLinkLogin` is enabled
**Access:** Issuance requires configured authentication and an existing active account allowed by the sign-in decision. Request uses generic acknowledgement and rate limits; completion must be bound to the requesting browser/app challenge.
**Entry:** Host calls `magicLink.request`, optional `magicLink.inspect`, then `magicLink.complete(input, guard)`, or mounts POST `auth/magic-link` and GET/POST `auth/magic-link/:token`.
**Documentation:** [magic-link.md](../docs/guide/magic-link.md)
**Source:** [`src/magic_link.ts`](../src/magic_link.ts)
**Coverage:** [`tests/magic_link.spec.ts`](../tests/magic_link.spec.ts), [`tests/magic_link_completion.spec.ts`](../tests/magic_link_completion.spec.ts)

## Acceptance criteria

- **Inputs and result:** `magicLink.request({ email, clientKey, clientChallenge })` returns `void`; it issues a link only for an existing active account allowed by sign-in policy. Unknown or denied addresses receive the same generic acknowledgement and do not create accounts. Challenge is a 43-character base64url SHA-256 digest of a verifier kept by the initiating client. `inspect({ token })` is non-consuming; `complete({ token, verifier }, guard)` returns account and credential. Inspection verifies matching current email and active status. A well-shaped completion with the wrong verifier consumes the link; an inactive account or denied `canAccess` check also consumes it. The owner must request a fresh link. Malformed proof and an address mismatch are refused without that consumption.
- Issuing a fresh magic link invalidates the older link for that account.
- Managed session routes require persistent AdonisJS session middleware. The browser keeps its session and the server derives the challenge and holds the verifier. Managed access-token clients send their own `clientChallenge` and `verifier`. Managed request returns the generic 202 and reports committed follow-up errors separately. Managed completion returns 200 with the represented account and a bearer token only in the access-token strategy.

## User flow

```mermaid
flowchart TD
 A["Client creates verifier and submits email plus its challenge"] --> B["Receive generic request acknowledgement"]
 B --> C["If a link is delivered, open it in the same browser or app"]
 C --> D{"Does inspection find a live link?"}
 D -->|No| E["Request another link"]
 D -->|Yes| F{"Are proof shape and account address valid?"}
 F -->|No| G["Refuse malformed proof or stale address without consuming the link"]
 F -->|Yes| H{"Does verifier match, and is the account active and allowed?"}
 H -->|No| I["Consume link and refuse; owner requests a fresh link"]
 H -->|Yes| J["Consume once and try to establish sign-in"]
 J -->|Failure| E
 J -->|Success| OK["Continue signed in"]
```

## Code flow

```mermaid
flowchart TD
  M["Managed request validates email; session handler derives challenge from stored or new verifier; token client supplies challenge"] --> A["magicLink.request"]
  A --> B["Check capability, authentication and inputs; consume client/email budgets and look up account"]
  B --> C{"Existing account still matches email, active and allowed under lock?"}
  C -->|No| K["Skip issuance"]
  C -->|Yes| T["Upsert hashed proof; commit and run delivery and lifecycle follow-ups"]
  K --> Z["Wait for timing floor"]
  T --> Z
  Z -->|Service| O["Resolve void or propagate failure"]
  Z -->|Managed success or reported committed failure| N["Session strategy acknowledges verifier binding; return generic 202"]
  I["Managed GET or direct magicLink.inspect"] --> J["Check live token, email and active state without consuming; return boolean or managed proof response"]
  W["Managed POST validates payload and gets verifier from session or access-token client; host may call directly"] --> R["magicLink.complete checks capability, guard and proof shape"]
  R -->|Malformed proof| X["Refuse before consumption"]
  R -->|Well-formed proof| S["Transaction attempts consumption and checks matching account email"]
  S -->|Invalid token or changed email| Y["Throw and roll back"]
  S -->|Matching account| V["Check verifier, active state and canAccess"]
  V -->|Refused| U["Commit consumption and throw invalid token"]
  V -->|Accepted| C2["Commit consumption, then establishCredential and recheck account before returning"]
  C2 -->|Issuance fails| CF["Refuse; committed link remains consumed"]
  C2 -->|Success| CF2["Return account and credential; managed session decrements browser binding, then managed handler returns strategy-specific 200"]
```

**Code references:** [implementation](../src/magic_link.ts), [`tests/magic_link.spec.ts`](../tests/magic_link.spec.ts), [`tests/magic_link_completion.spec.ts`](../tests/magic_link_completion.spec.ts), [managed magic link](../src/http/handlers_magic_link.ts), [session binding](../src/http/magic_link_session.ts), [credential issuance](../src/credential_issuance.ts)
