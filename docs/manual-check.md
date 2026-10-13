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

At the T8.1 checkpoint, package validation passed on the same Node 24 toolchain:

```sh
DB_CLIENT=better-sqlite3 pnpm test        # 121 passed; includes lint
DB_CLIENT=pg DB_HOST=127.0.0.1 DB_PORT=55432 DB_USER=account_kit DB_DATABASE=account_kit_test pnpm test  # 123 passed; includes lint
pnpm typecheck
pnpm build
```

These T8.1 totals precede the additional SQLite-only regression test documented under T8.2. Both database runs use the package test harness; the fresh consumer uses a distinct PostgreSQL database. The HTTP rehearsal used `pnpm exec node ace migration:run`, `pnpm typecheck`, and `pnpm exec node ace test --suite=functional` for each selected connection.

The starter-kit fork, fork-derived stubs and documentation synchronization, browser checks, and owner application integration remain deferred to stage 7.

## T8.2: upgrade an existing consumer

Verified on 2026-10-13 in a second fresh official API-kit app. The app first installed the stage-3 package archive (SHA-256 `a98d746e90bef50bb71ba6d5bd4b0b138a302314bc2eeedcf998232b725606df`); the recovery baseline passed over real HTTP on SQLite and PostgreSQL. Before upgrade, both databases had seven migration-ledger rows, including all four package migrations, plus one verified baseline account.

The app was then upgraded to the stage-6 candidate archive recorded above. The installed package resolved from that archive and remained version `0.0.0`. Candidate configure skipped the existing application config, provider, and all four migration files. The config SHA-256 remained `ae636bcaa3dfe5b93cdd6548b9c98045ec3458eb153cbce6c21a4712986ab4b8`, and migration runs reported no pending migrations on either database. The pre-existing verified account remained present. The recovery baseline passed again after upgrade on both dialects. A consumer-only role fixture migration was added after this check, leaving eight total migration rows, four belonging to the package.

The upgraded app passed two functional HTTP tests on each dialect and passed consumer typecheck. The expanded workflow included resend and revoke through authenticated routes with authorization callbacks that perform ordinary database reads. Its SQLite pool used `min: 1` and `max: 4`, so those reads could use a separate connection while the package held a transaction. Email-change confirmation was delivered to the requested new address, with the change notice sent to the old address.

Consumer versions were Node `24.19.0`, pnpm `11.23.0`, Core `7.6.0`, assembler `8.5.2`, Lucid `22.4.2`, Auth `10.1.0`, Knex `3.3.0`, Luxon `3.7.2`, better-sqlite3 `13.0.3` with SQLite `3.53.4`, pg `8.23.1`, and PostgreSQL `16.15`.

After a SQLite-only package regression test was added, package source checks passed: 122 SQLite tests and 123 PostgreSQL tests, with lint included in each run; `pnpm typecheck` and `pnpm build` also passed. Runtime source was unchanged from stage 6; the consumer HTTP checks used the candidate archive. These totals are distinct from the T8.1 checkpoint above.
