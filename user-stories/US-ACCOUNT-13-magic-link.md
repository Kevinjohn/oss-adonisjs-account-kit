# US-ACCOUNT-13 — Sign in with an email link

As an existing account holder, I want to request and complete an opt-in passwordless sign-in link so that I can sign in without entering a password.

**Status:** Current when `magicLinkLogin` is enabled
**Access:** Links are issued only to existing active accounts allowed by sign-in policy. Request uses generic acknowledgement and rate limits; completion must be bound to the requesting browser/app challenge.
**Entry:** Host calls `magicLink.request` and `magicLink.complete`, or explicitly enables managed routes.
**Documentation:** [magic-link.md](../docs/guide/magic-link.md)
**Source:** [`src/magic_link.ts`](../src/magic_link.ts)
**Coverage:** [`tests/magic_link.spec.ts`](../tests/magic_link.spec.ts), [`tests/magic_link_completion.spec.ts`](../tests/magic_link_completion.spec.ts)

## Acceptance criteria

- **Inputs and result:** `magicLink.request({ email, clientKey, clientChallenge })` returns `void`; it issues a link only for an existing active account allowed by sign-in policy. Unknown or denied addresses receive the same generic acknowledgement and do not create accounts. Challenge is a 43-character base64url SHA-256 digest of a verifier kept by the initiating client. `inspect({ token })` is non-consuming; `complete({ token, verifier }, guard)` returns account and credential. A well-shaped completion with the wrong verifier consumes the link; an inactive account or denied `canAccess` check also consumes it. The owner must request a fresh link. Malformed proof and an address mismatch are refused without that consumption.
- Issuing a fresh magic link invalidates the older link for that account.

## User flow

```mermaid
flowchart TD
 A["Client creates verifier and submits email plus its challenge"] --> B["Receive generic request acknowledgement"]
 B --> C["Open link in the same browser or app"]
 C --> D{"Does inspection find a live link?"}
 D -->|No| E["Request another link"]
 D -->|Yes| F{"Are proof shape and account address valid?"}
 F -->|No| G["Refuse malformed proof or stale address without consuming the link"]
 F -->|Yes| H{"Does verifier match, and is the account active and allowed?"}
 H -->|No| I["Consume link and refuse; owner requests a fresh link"]
 H -->|Yes| J["Consume once and establish sign-in credential"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["magicLink.request"] --> B["Validate client challenge, throttle and create hashed proof transactionally"]
 B --> C["Commit and deliver provision; acknowledge generically"]
 D["magicLink.inspect"] --> E["Read token expiry/account status without consuming"]
 F["magicLink.complete"] --> G{"Are token and verifier well-shaped?"}
 G -->|No| H["Reject before transaction; link remains unused"]
 G -->|Yes| I["Transaction tries to consume live token and checks matching account email"]
 I --> J{"Does token address match the account?"}
 J -->|No| O["Throw invalid-token error; transaction rollback preserves token"]
 J -->|Yes| K["Keep consumed token; compare verifier and check active status and canAccess"]
 K --> L{"Do verifier and account checks pass?"}
 L -->|No| M["Commit consumed link and refuse; owner requests a fresh link"]
 L -->|Yes| N["Guard establishes credential and service returns account/credential"]
```

**Code references:** [implementation](../src/magic_link.ts), [`tests/magic_link.spec.ts`](../tests/magic_link.spec.ts), [`tests/magic_link_completion.spec.ts`](../tests/magic_link_completion.spec.ts)
