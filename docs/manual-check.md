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

## T8.4: API and operation review (historical, before consolidated review)

The earlier independent review completed on 2026-10-13 against the approved public API and operation
specifications. Its conclusion that no outstanding required fixes remained describes that earlier
review only; it was superseded by the consolidated review below. The review identified a SQLite integration
requirement: invitation management authorization can perform ordinary database reads only when
another pool connection is available. The README now documents callback placement, retry safety,
and connection capacity. An isolated two-connection regression verifies separate policy and
transaction connections; the fresh and upgraded HTTP consumers exercise this pattern on both
databases.

That milestone's source gates were 122 SQLite tests, 123 PostgreSQL tests, lint, typecheck, and build.
That review recorded these follow-ups, addressed by the corrections below:

- **P2, optional:** PostgreSQL credential operations acquired user and token locks in different orders and could
  propagate transient deadlock errors. Atomic state remains protected; PostgreSQL retries are
  outside the approved transaction policy. See [password change](../src/credentials.ts#L40),
  [recovery reset](../src/recovery.ts#L45), and [email-change completion](../src/credentials.ts#L125).
- **P2, optional:** Validate [minRequestMs](../src/account_kit.ts#L78) as finite and non-negative. The earlier
  contract accepted values such as `Infinity` and `NaN`; the default is 300 ms.
- **P3, optional:** Strengthen [recovery rollback coverage](../tests/recovery.spec.ts#L447) with an adapter that
  writes the password and then throws. The earlier recovery case threw before that write;
  credential-change tests already cover write-then-throw behavior.
- **P3, optional:** The [default email lookup](../stubs/config/account_kit.stub#L27) applied `LOWER(TRIM(email))`.
  This may require an expression index for efficient lookup at larger user counts; no workload
  performance claim was tested.

The [dependency audit](compatibility.md#dependency-audit) still has 16 unresolved advisories.
The current milestone completes package implementation and API-kit validation. Stage 7,
fork/browser work, owner application integration, and publication remain deferred.

## T8.5: consolidated review corrections

The later review identified transaction and error-contract defects, recovery timing guidance,
configuration hardening, test gaps and deferred release prerequisites. Corrections applied on
2026-10-13 now pass 129 SQLite tests and 130 PostgreSQL tests, lint, typecheck, build and the two-test
built-export smoke gate. The earlier counts and archive hashes above remain historical evidence.

PostgreSQL regressions cover rejected deferred-constraint commits at the helper and public password
operation, zero commit events/callbacks on failure, restored durable state, connection reuse, and
rejection of active global transactions. Both dialects exercise the stricter password/reset race,
recovery write-then-throw rollback and full invitation/recovery/email-change workflow with UUID
strings and matching text foreign keys. SQLite also checks exact unique-column classification
through Lucid's query-prefixed errors. The new bug regressions failed against the original behavior
before their fixes were applied.

Recovery retains its configured response-duration floor; it does not establish constant response
timing. Prompt notification enqueueing and generic acknowledgements are application integration
requirements. PostgreSQL retains no general transaction retry policy. The earlier optional
follow-ups above are addressed; the recorded dependency advisories remain unresolved.

The final repaired archive SHA-256 is
`74396513d353372f63e2f427c36ff2c60c2b567b58992813eda725c6e60a2383`.
A private copy of the retained configured API consumer installed this archive through pnpm with a
frozen lockfile and dependency scripts disabled. Consumer `pnpm typecheck` passed, followed by two
functional HTTP tests on SQLite and two on PostgreSQL. The copied adapter used the new normalized
email equality lookup; the application's notification, role and credential callbacks were retained.
Fresh migrations had already passed on the copied SQLite file and a separate PostgreSQL database.

These checks exercised invitation acceptance, role assignment, authenticated resend/revoke,
recovery acknowledgement/inspection/reset/replay, verification, password change/access-token
revocation, and normalized email-change confirmation/notification/replay. This was a copied
configured app, not a newly generated app or a repeat of the full stage-3 upgrade rehearsal.
Earlier consumer passes and hashes remain historical evidence.

An initial offline install lacked cached dependencies; it supplied only preliminary runtime checks
using an extracted archive. The final normal pnpm installation and checks above supersede that
limitation. The first test archive and final archive differ only in README constraint-name wording;
runtime, declarations, stubs and package manifest were byte-identical. The final archive itself was
then installed and tested through pnpm.

The final source review found no remaining findings, nits or questions in these corrections.
Release setup and hooks are prepared but no version, publish or hosted release command was run.
Stage 7, starter/browser work, owner application integration and publication remain deferred.

## T8.6: account-operation refactor and custom-table support

The subsequent refactor shares token-consumption, password validation and post-commit effect
helpers, reduces repeated test setup, validates recovery client keys, reports missing provider
configuration, and preserves `APP_URL` subpaths. Email-change notices are attempted after a failing
credential callback; multiple post-commit failures retain their order in an `AggregateError`.

Custom-table support now quotes SQLite identifiers and maps PostgreSQL's stored constraint-name
truncation. The application prerequisites describe all three foreign-key targets, both verification
migration directions, and the PostgreSQL-specific 62-character table-name boundary. Configure
continues to generate application-owned migrations for `users`; it does not rewrite existing ones.

The custom-table regressions first reproduced a reserved SQLite table failure and a raw PostgreSQL
unique error for a long table name. Four service cases now use `accounts`, `order`, and 54- and
62-character names without a `users` table. They cover verification, invitation acceptance,
recovery, password change, email change, real unique-error mapping and rollback. The conflict is
injected within the adapter transaction for deterministic error coverage; the existing independent
race tests continue to cover concurrency. A separate native-connection assertion verifies the
custom-table write lock blocks another SQLite writer.

Local validation passed on Node 24.19.0 and pnpm 11.23.0: lint, typecheck, build, three built-export
tests, 138 SQLite tests and 139 PostgreSQL tests. The final code review found no remaining findings
in the refactor and corrections. All PostgreSQL work used an isolated local database. No GitHub
Actions, dependency changes, versioning, release, publication or deployment ran.

These are source/build checks. The tarball hash and copied-consumer HTTP checks in T8.5 remain
historical evidence for the earlier runtime; this task did not repeat package installation or the
consumer/browser rehearsal. The existing dependency advisories and deferred stage-7 work remain.
