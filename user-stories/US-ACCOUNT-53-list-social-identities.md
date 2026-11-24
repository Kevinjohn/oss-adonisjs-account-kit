# US-ACCOUNT-53 — Review linked social identities

As a signed-in account holder, I want to review my confirmed provider identities so that I can see which accounts can sign in here.

**Status:** Current when `socialAuthentication` is enabled
**Access:** The configured sign-in must be current. Limited access allows an inactive account to call the list endpoint.
**Entry:** Host calls `socialAuthentication.list({ current })` or `get({ current, identityId })`. Managed GET `account/social-identities` exposes the list.
**Documentation:** [Social authentication](../docs/guide/social-authentication.md)
**Source:** [`src/social_identity.ts`](../src/social_identity.ts)
**Coverage:** [Pending relationship inventory](../tests/social_identity_continuation.spec.ts), [detail lookup](../tests/social_identity_unlink.spec.ts), [managed routes](../tests/managed_social_http.spec.ts)

## Acceptance criteria

- `list({ current })` takes `CurrentAccountInput` and returns the caller’s confirmed `SocialIdentity[]` ordered by ID and excludes pending relationships. The service returns `id`, `userId`, `provider`, `providerUserId`, `email` and `emailVerified`. `get` also takes numeric `identityId` and returns one confirmed caller-owned identity.
- Managed GET returns 200 `{ identities }` with `id`, `provider`, `email` and `emailVerified` per item.
- A stale credential is refused; `get` of an unknown, unconfirmed or foreign identity returns the same not-found outcome. Displayed provider email is relationship metadata and is never an account-merge key.

## User flow

```mermaid
flowchart TD
 A["Signed-in person asks host to list linked providers"] --> B{"Does current credential and revision validate?"}
 B -->|No| C["Return authentication refusal"]
 B -->|Yes| D["Show only confirmed identities linked to this account"]
 D --> E{"Does person request one identity detail?"}
 E -->|No| F["Finish with provider list"]
 E -->|Yes| G{"Is identity confirmed and owned by this account?"}
 G -->|No| H["Return not-found outcome"]
 G -->|Yes| I["Return that provider relationship"]
```

## Code flow

Scope: managed list response and the host service’s list and detail results.

```mermaid
flowchart TD
 M["Managed account.socialIdentities.list checks the selected current guard"] --> A
 A["socialAuthentication.list calls listSocialIdentities"] --> B
 D["socialAuthentication.get calls listSocialIdentities for current input"] --> B
 B["Transaction validates current and loads confirmed owned rows ordered by ID"] -->|Refusal| X["Propagate current-account error"]
 B -->|Success| C{"Caller?"}
 C -->|Service list| S["Return SocialIdentity list"]
 C -->|Managed list| H["Map projectSocialIdentity and return 200 with identities"]
 C -->|Service detail| F{"Exact identityId in confirmed list?"}
 F -->|No| G["Throw E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND"]
 F -->|Yes| I["Return one SocialIdentity"]
```

**Code references:** [service entry and detail lookup](../src/social_identity.ts), [confirmed relationship query](../src/social_links.ts), [managed execution](../src/http/managed_execution.ts), [managed list projection](../src/http/managed_social_account_handlers.ts), [inventory test](../tests/social_identity_continuation.spec.ts)
