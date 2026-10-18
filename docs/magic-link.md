# Magic-link sign-in

Users sign in by clicking a link sent to their email address. The link works once, expires after
15 minutes by default, and only works in the browser or app that asked for it.

## Configuration

`magicLinkLogin` is off by default and requires `authentication`:

```ts
export default defineConfig({
  // ...
  enabled: ['passwordReset', 'magicLinkLogin'],
  authentication: { strategy: 'session', guard: 'web' },
  expiresIn: { magicLink: '15m' },
  urls: {
    // ...
    magicLink: (token) => `https://app.example.com/sign-in/link/${encodeURIComponent(token)}`,
  },
  notify: {
    // ...
    magicLinkProvision: async (user, url) => {
      /* send url to user.email */
    },
  },
})
```

With `createActionUrls`, add a `magicLink` destination. `createMailNotifications` already has the
English "Your sign-in link" template. Run `node ace configure adonisjs-account-kit` and
`node ace migration:run` to create the `login_link_tokens` table.

## Service API

```ts
// The client keeps `verifier` and sends only its SHA-256 challenge.
await kit.magicLink.request({ email, clientKey: request.ip(), clientChallenge })

// Read-only. Mail scanners prefetch links, so inspection never uses the link.
const valid = await kit.magicLink.inspect({ token })

// Uses the link and signs in through the configured guard.
const { account, credential } = await kit.magicLink.complete({ token, verifier }, guard)
```

- `clientChallenge` is the base64url SHA-256 of `verifier` (43 characters). `verifier` is 43 to 128
  characters from `A-Z a-z 0-9 - . _ ~`, as in OAuth PKCE.
- `request` returns nothing for every address, waits out `minRequestMs`, and throttles by client
  and by email. Unknown addresses, accounts that never confirmed their email, and accounts
  `canAccess` denies get no link.
- `complete` throws `InvalidTokenError` for an unknown, expired or used link, a wrong verifier, an
  inactive account, or a denied account. `guard` is the same adapter `kit.authentication.login`
  takes.
- Delivery and lifecycle failures after the link is stored throw `DeliveryError` or
  `PostCommitError`. Treat them as success and answer the client generically.

## Managed routes

With `registerManagedRoutes`, add `magicLinkLogin` to `enabled`:

| Method | Path                      | Body                          | Success                             |
| ------ | ------------------------- | ----------------------------- | ----------------------------------- |
| `POST` | `/auth/magic-link`        | `{ email, clientChallenge? }` | `202 { message }`                   |
| `GET`  | `/auth/magic-link/:token` | —                             | `200 { valid: true }`               |
| `POST` | `/auth/magic-link/:token` | `{ verifier? }`               | `200 { account, token? }`, as login |

- **Session guards** keep the verifier on the server. The request route stores it in the session,
  so the link works in any tab of the same browser. Clients send neither `clientChallenge` nor
  `verifier`; a `clientChallenge` sent with a session guard is ignored.
- **Access-token guards** require `clientChallenge` on request and `verifier` on completion, and
  the mount requires `publicCredential`.
- The request route answers `202` with the same body for known and unknown addresses, including
  when the email or a lifecycle hook fails.
- An invalid link returns `400` with code `E_INVALID_MAGIC_LINK`.

## The landing page

The emailed URL points at your frontend (`urls.magicLink`). The page should:

1. Call `GET auth/magic-link/:token` to show whether the link is still valid. This does not use it.
2. Show a "Sign in" button. Do not complete on page load: link scanners and previews open links
   automatically.
3. On click, call `POST auth/magic-link/:token` (with `verifier` for access-token clients).
4. On `E_INVALID_MAGIC_LINK`, offer to send a new link.

Native and single-page clients generate the verifier with a secure random source before the
request, keep it in memory or app storage, and send it on completion:

```ts
const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
const clientChallenge = base64url(
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
)
```

## How it works

### One live link per account

The table holds one row per user. A new request replaces the previous link. Only a hash of the
token is stored, with the email address and the client challenge.

### The link is bound to the client that asked

The link alone cannot sign anyone in: completion also needs the verifier. A forwarded link, a
link an attacker requests for a victim, or an intercepted email fails in any other browser. The
cost is that users must open the link where they asked for it.

### Any failed completion uses up the link

Once the token matches, the link is consumed even if the verifier is wrong or the account is now
inactive or denied. A link presented with the wrong verifier may have been intercepted. A
malformed token or verifier, or a guard mismatch, consumes nothing.

### Credential changes cancel links

Every credential change deletes the account's sign-in links: password reset and change, email
change, access-restriction change, social unlink and activation. This happens whether or not
`magicLinkLogin` is enabled, so the table must exist in every installation. A link issued for an
address that is no longer the account's email is rejected.

### Sign-in re-checks the account

After the guard issues the credential, the account is locked and re-read. If its email, credential
revision or `canAccess` result changed, the credential is terminated and completion fails.

### Not included

- Magic links do not activate accounts. An account that never confirmed its email cannot get one.
- `auth.methods` does not remember magic links as the last used method.
- Retirement impact and the last-login-method check do not count magic links as a way to sign in.

## Pruning

`account-kit:prune` deletes expired rows from `login_link_tokens` and reports them as
`loginLinks`.
