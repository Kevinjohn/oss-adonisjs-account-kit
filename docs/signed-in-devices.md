# Signed-in devices

Users see where they are signed in and sign out one device, every other device, or everywhere.

## Configuration

`sessionManagement` is off by default and requires `authentication`:

```ts
export default defineConfig({
  // ...
  enabled: ['passwordReset', 'sessionManagement'],
  authentication: { strategy: 'session', guard: 'web' },
  sessionManagement: { idleExpiry: '30d' },
})
```

Run `node ace configure adonisjs-account-kit` and `node ace migration:run` to create the
`account_sessions` table.

- `idleExpiry` (default `'30d'`) is how long a session sign-in lasts without use. It must be longer
  than five minutes. It applies to the session strategy only; access tokens keep the expiry the
  token guard gives them.
- With the session strategy, turning the capability on signs out every existing browser session
  once: those sessions have no sign-in record, and `current` rejects them.

## Service API

```ts
// `current` is the same trusted input `kit.authentication.current` takes.
const signIns = await kit.authentication.sessions.list({ current })
const { current: wasMine } = await kit.authentication.sessions.revoke({ current, id })
const { count } = await kit.authentication.sessions.revokeOthers({ current })
await kit.authentication.sessions.revokeAll({ current })
```

Each entry of `list` is
`{ id, label, createdAt, lastSeenAt, expiresAt, current }`, newest first, without expired entries.
`label` is the text passed as `sessionLabel` at login; the managed routes pass the `User-Agent`
header. It is untrusted display text, truncated to 255 characters.

```ts
await kit.authentication.login({ email, password, clientKey, sessionLabel }, guard)
```

- `revoke` throws `SessionNotFoundError` for an id that is unknown, malformed or belongs to another
  account. All three look the same. It returns `{ current: true }` when the caller revoked its own
  sign-in; end the caller's session then.
- `revokeOthers` keeps the caller signed in.
- `revokeAll` is a credential change (`sign_out_everywhere`): it advances the credential revision,
  so every session and token of the account stops working, and it runs `onCredentialsChanged`.
  End the caller's session afterwards.
- Every call first checks the caller with `current`, in the same transaction, so a revoked caller
  cannot manage sign-ins.
- Observer failures after the change has committed throw `PostCommitError`. Treat the change as
  done.

Lifecycle events: `sessions.revoked` (`userId`, `operationId`, `count`) for `revoke` and
`revokeOthers`, and `sessions.revoked_all` (`userId`, `operationId`) for `revokeAll`.

## Managed routes

With `registerManagedRoutes`, add `sessionManagement` to `enabled`:

| Method   | Path                              | Success                |
| -------- | --------------------------------- | ---------------------- |
| `GET`    | `/account/sessions`               | `200 { sessions: [] }` |
| `DELETE` | `/account/sessions/:id`           | `204`                  |
| `POST`   | `/account/sessions/revoke-others` | `200 { count }`        |
| `POST`   | `/account/sessions/revoke-all`    | `204`                  |

- All four are `limited`: unverified accounts can use them.
- An unknown or foreign id returns `404` with code `E_ACCOUNT_KIT_SESSION_NOT_FOUND`.
- Revoking the caller's own sign-in, and signing out everywhere, also destroy the caller's
  AdonisJS session. This happens even when a lifecycle observer fails and the route answers
  `202 { committed: true }`. A session that cannot be destroyed is logged as
  `session_end_failed`; the revocation stands and the route answers as usual.
- `createManagedGuard` stores the sign-in handle in the session under `accountKitSession` and
  passes the label to `accessTokens.create` as the token `name`.

## How it works

![Listing signed-in devices, then signing out every other device](assets/demos/devices.svg)

### Sessions

At login the package generates a random handle. The guard keeps it in the server-side session;
the `account_sessions` table stores only its SHA-256 hash, with the label and timestamps. On every
protected request, `current` looks up the handle for the signed-in user. A missing, foreign or
expired handle is rejected as an invalid session. An accepted request extends `last_seen_at` and
`expires_at` at most once every five minutes, after all access checks pass.

Revoking deletes the row. The browser that held it is rejected on its next request.

### Access tokens

The token strategy needs no extra table. `list` reads the AdonisJS `auth_access_tokens` table:
`label` is the token `name` and `lastSeenAt` is `last_used_at`. Revoking deletes the token row.

### Credential changes

Every credential change (password reset or change, email change, restriction change, social
unlink, sign out everywhere) deletes the account's `account_sessions` rows whenever
`authentication` is configured, even with the capability off. The table is therefore required in
every installation that uses `authentication`. The credential revision already signs out older
sessions; deleting the rows keeps the list accurate.

A self-service password change is the one exception. `changePassword({ ..., keepCurrent })` keeps
the caller's own sign-in: `keepCurrent.sessionHandle` keeps that `account_sessions` row and
`keepCurrent.tokenId` keeps that access token. Every other one is deleted. A handle or id that
matches nothing deletes them all. The call returns `{ revision }`, the new credential revision. A
session guard must store it where `establish` stored the first one, or the next request fails the
revision check. The managed session guard's `refresh(revision)` does this, and the managed
password-change route passes `keepCurrent` and calls it. Password reset, email change, restriction,
social unlink and sign out everywhere still end every sign-in.

### Custom guard adapters

The session adapter's `establish(userId, revision, handle?)` receives a handle when the capability
is on and must make `current` return it as `sessionHandle`. The token adapter's
`establish(userId, abilities, expiresIn, options?)` receives `{ name }` when a label is given.

## Pruning

`account-kit:prune` deletes expired rows from `account_sessions` and reports them as `sessions`.
