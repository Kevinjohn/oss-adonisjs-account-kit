# Account export and deletion

A signed-in user can download the personal data Account Kit holds, merged with your application's
data, and can permanently delete their account. Both need fresh re-authentication.

## Configuration

Both capabilities are off by default and independent:

```ts
export default defineConfig({
  // ...
  enabled: ['passwordReset', 'dataExport', 'accountDeletion'],
  // Optional: your application's part of the export.
  exportAccountData: async (user, trx) => ({
    projects: await trx.from('projects').where('owner_id', user.id).select('id', 'name'),
  }),
  // Optional: delete or anonymise your rows before the user row goes.
  onAccountDeletingTransaction: async (user, trx) => {
    await trx.from('projects').where('owner_id', user.id).delete()
  },
  accountDeletion: { invitations: 'revoke' },
  notify: {
    // ...
    accountDeleted: async ({ id, email }) => {
      /* confirm the deletion to email */
    },
  },
})
```

- `accountDeletion` needs `users.delete(id, trx)` on the users adapter. The Lucid adapter has it;
  it deletes through the model, so model hooks run.
- `accountDeletion` needs `notify.accountDeleted`. `createMailNotifications` has the English "Your
  account was deleted" template.
- No migration is needed.

## Re-authentication

Both operations take `{ actorId, currentPassword?, recentProof? }`, like a password change:

- Accounts with a password send `currentPassword`.
- Password-less accounts send a single-use `recentProof` with purpose `account_export` or
  `account_delete`. Only a social provider that attests fresh authentication
  (`verifyFreshAuthentication`) can issue one. With the standard Ally adapters, the user sets a
  first password through password reset and then uses it.
- Every attempt, successful or not, uses the `identity:user` limit.
- A wrong password throws `IdentityNotConfirmedError`; a wrong, used or expired proof throws
  `SocialProofError`.

## Export

```ts
const document = await kit.accountData.export({ actorId, currentPassword })
```

The document, version 1 (timestamps are ISO 8601 UTC strings):

```json
{
  "format": "adonisjs-account-kit/export",
  "version": 1,
  "generatedAt": "2026-10-18T12:00:00.000Z",
  "account": {
    "id": 1,
    "email": "person@example.com",
    "unverifiedEmail": null,
    "emailVerifiedAt": "2026-01-02T03:04:05.000Z",
    "hasPassword": true,
    "credentialsChangedAt": null
  },
  "socialIdentities": [
    {
      "provider": "github",
      "providerUserId": "12345",
      "email": "person@example.com",
      "emailVerified": true,
      "name": "Person",
      "nickname": "person",
      "avatarUrl": "https://avatars.example.com/u/12345",
      "confirmedAt": "2026-01-02T03:04:05.000Z",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "invitationsSent": [
    {
      "email": "friend@example.com",
      "role": "member",
      "createdAt": "2026-10-01T00:00:00.000Z",
      "expiresAt": "2026-10-08T00:00:00.000Z"
    }
  ],
  "accessTokens": [
    {
      "id": 7,
      "name": "Laptop",
      "createdAt": "2026-10-01T00:00:00.000Z",
      "lastUsedAt": null,
      "expiresAt": null
    }
  ],
  "pending": { "passwordReset": false, "emailVerification": false, "emailChange": null },
  "application": { "projects": [] }
}
```

- `accessTokens` is present only for the `access_tokens` strategy.
- `pending` says whether an unexpired password reset or email confirmation exists, and the address
  of a pending email change.
- `application` is what `exportAccountData` returned, passed through JSON, or `null` without the
  hook. Returning `undefined` or a value JSON cannot represent fails the export before it commits.
- The export never contains password hashes, token hashes, provider tokens, provider `meta`, or
  in-flight social sign-in state.
- Export publishes no lifecycle event.

### Consistency

The export runs in one transaction that holds the user lock, so package data that changes under
that lock (the account, its proofs and identities) cannot change while it is read. Invitation
rows, pruning, and your application data are read as committed at the time of each query.

### Faults after commit

The only write is consuming the proof. If something fails after the commit, `export` still returns
the complete document. The managed route sends it and logs a `followup_failed` diagnostic.

## Deletion

```ts
await kit.accountData.delete({ actorId, currentPassword })
```

In one transaction under the user lock:

1. Re-authenticate.
2. Run `onAccountDeletingTransaction(user, trx)`. Use only `trx`: the hook may run again when
   SQLite retries a busy transaction, so it must not call remote services. Throwing aborts the
   deletion and rolls everything back.
3. Delete the package rows explicitly, without relying on foreign-key cascades: social handoff
   codes, sensitive-action proofs, social sign-in state, social identities, password reset and
   email verification tokens. Social rows are deleted even when social sign-in is disabled.
4. With the `access_tokens` strategy, delete the user's access tokens.
5. Handle invitations the user sent: `revoke` (default) deletes them; `keep` leaves them acceptable
   with no inviter.
6. Delete the user row through `users.delete`.

After the commit, `notify.accountDeleted({ id, email })` and the lifecycle event `account.deleted`
(`userId`, `operationId`) both run, even if one fails. A failed email throws `DeliveryError`; a
failed observer throws `PostCommitError`. Either way the account is gone: do not retry the
deletion.

### What stays your responsibility

Account Kit deletes only the rows it owns. Your application still owns:

- Its own tables, unless `onAccountDeletingTransaction` handles them.
- Other stores: files, caches, search indexes, analytics, and payment or email processors.
- Remember-me tokens and database-backed sessions. Session-store sessions fail on their next
  request because the user no longer exists.
- Logs and backups.

Grace periods, scheduled deletion and deletion by an operator are not included.

## Managed routes

With `registerManagedRoutes`, add `dataExport` and `accountDeletion` to `enabled`:

| Method   | Path              | Body                                 | Success                    |
| -------- | ----------------- | ------------------------------------ | -------------------------- |
| `POST`   | `/account/export` | `{ currentPassword?, recentProof? }` | `200`, the export document |
| `DELETE` | `/account`        | `{ currentPassword?, recentProof? }` | `204`                      |

- Both routes are `limited`: unverified accounts can use them.
- The export response sets `Cache-Control: no-store` and
  `Content-Disposition: attachment; filename="account-export.json"`.
- A wrong password returns `403` with code `E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED`.
- With the session strategy, deletion destroys the caller's session, also when the email or an
  observer fails and the route answers `202 { committed: true }`. A session that cannot be
  destroyed is logged as `session_end_failed`; the deletion stands.
- With the access-token strategy, the bearer token was deleted with the account; the next request
  with it returns `401`.
