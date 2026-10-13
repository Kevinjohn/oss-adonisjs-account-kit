# Manual consumer verification

## T8.1: fresh API-kit install

Verified on 2026-10-13 against source commit `64e154203c0bf1aaf36957e97f39f2d440aa2ccb`. The candidate archive SHA-256 was `5c79076a154be648fe5923a2ecfef6b3d33daaf48cb57bad0eebf49d472473e2`. A new official AdonisJS API-kit app was generated with `pnpm create adonisjs@3.4.0 scratch --kit=api --pkg=pnpm`; the local dependency resolved to `adonisjs-account-kit@0.0.0` from that candidate archive.

Toolchain and consumer versions: Node `24.19.0`, pnpm `11.23.0`, AdonisJS Core `7.6.0`, Lucid `22.4.2`, Auth `10.1.0`, limiter `3.0.1`, better-sqlite3 `13.0.3`, and pg `8.23.1`. PostgreSQL was `16.15`. The app used its generated SQLite database and a separate local PostgreSQL database. SQLite foreign keys were enabled for every connection. The generated User model used `withAuthFinder` for password hashing, and its email verification timestamp was added by the package migration.

The consumer applied eight migrations on each database: two API-kit base migrations, four package migrations, the limiter table migration, and one consumer-only role fixture migration. Consumer typecheck passed. One real HTTP Japa workflow test passed on each dialect. The SQLite pool was configured with `min: 1` and `max: 4`. Invite and management authorization callbacks performed normal database reads to validate the actor. It covered:

- Recovery requests for known, unknown, and notification-failure cases all returned the same 202 acknowledgement. Invalid email input was rejected. Repeated GET inspection preserved the token, reset stored a verified account with a new hashed password, and replay was rejected. Recovery, verification, invitation inspection, invitation acceptance, and email-change token responses set `Referrer-Policy: no-referrer`.
- Verification sending required authentication; completion returned `verified` and then `already_verified`, and a later send returned `already_verified` without a second notification.
- Invitation sending required authentication. Inspection did not consume the link. Acceptance created a verified user with a hashed password, and the application role callback wrote its assignment through the supplied transaction. Replay was rejected. The confirmation was sent to the invited mailbox.
- Invitation resend and revoke both ran through authenticated HTTP routes. The management callback queried the actor through the ordinary database connection; the larger SQLite pool supported that lookup while the package held its write transaction. Resend rotated the token, the old link failed, and the new link remained usable until revoke.
- Password change required the current password, stored the new hash, and removed the user’s API access tokens after commit. An invalid proof returned the same generic credential error.
- Email-change request required authentication and the current password. The confirmation went to the requested new mailbox, and the GET landing route did not consume the token. POST changed and verified the normalized email, notified the old address after commit, invalidated API access tokens, and rejected replay.
- Authenticated routes rejected anonymous requests, and invalid request bodies received validation errors.

Package validation passed on the same Node 24 toolchain:

```sh
DB_CLIENT=better-sqlite3 pnpm test        # 121 passed; includes lint
DB_CLIENT=pg DB_HOST=127.0.0.1 DB_PORT=55432 DB_USER=account_kit DB_DATABASE=account_kit_test pnpm test  # 123 passed; includes lint
pnpm typecheck
pnpm build
```

Both database runs use the package test harness; the fresh consumer uses a distinct PostgreSQL database. The HTTP rehearsal used `pnpm exec node ace migration:run`, `pnpm typecheck`, and `pnpm exec node ace test --suite=functional` for each selected connection.

The starter-kit fork, fork-derived stubs and documentation synchronization, browser checks, and owner application integration remain deferred to stage 7.
