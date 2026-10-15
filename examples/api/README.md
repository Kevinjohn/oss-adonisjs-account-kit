# Account API consumer fixture

This is the application-owned Adonis 7 API example used by the packed-consumer gate. It includes
routes, validation, central error mapping, a maintained lazy Lucid user adapter, captured
notifications, migrations, and HTTP flow tests. The test harness copies this fixture outside the
repository, inserts the exact candidate tarball as its `adonisjs-account-kit` dependency, runs the
package configure command, and tests the installed package. It never resolves the repository source
or reuses this checkout's `node_modules`.

Use the repository's `test:consumer` script to run it. A separate baseline tarball is required to
run the upgrade scenario. PostgreSQL runs require the dedicated `account_kit_consumer` database;
the harness resets its `public` schema before each independent scenario.
The historical baseline config is kept in `upgrade/baseline_account_kit.stub` so current-app
typechecking does not compile old package contracts. The upgrade harness copies that stub into
the temporary application config only for its baseline phase.
The upgrade scenario uses an application-owned handler compatible with the preserved baseline
package, then exercises password reset through its preserved config and adapter before hashing the
baseline config and migration files. It verifies configure preserves them, then applies the
maintained candidate config, controller and exception handler as documented manual upgrade steps.
It changes the newly generated reset-token migration to rename the existing table, preserving rows
and applied migration files, before booting and typechecking the candidate. See the
[vocabulary upgrade guide](../../docs/upgrade.md#vocabulary-alignment). The candidate-phase test verifies the recovered password,
user data, role assignment, and application migration record survived.

Before adapting these routes, configure trusted proxy addresses so `request.ip()` cannot be spoofed.
Login allows five attempts per client and normalized email pair, and 20 attempts per client, within
15 minutes. Limiter keys are HMACs derived from `APP_KEY` and do not persist email addresses or client
IPs. The password reset limiter
also uses `request.ip()` as its client key. Keep `APP_URL` on HTTPS in production so generated links
are secure. These example routes use bearer-token authentication. If you adapt
them to cookie-authenticated browser sessions, enable and validate CSRF protection for state-changing
requests rather than assuming JSON content types provide it.

The credential-notice outbox stores password-reset and password-change operation IDs, kinds, and
recipient addresses; it does not store passwords or bearer tokens. Credential changes revoke API
tokens transactionally for every operation. In this example, the old-address email-change security
notice remains best-effort post-commit; an application that needs durable delivery must persist the
previous recipient transactionally in its own outbox recipe.

The sample dispatcher leaves failed rows pending and stops at the first failed row, so later rows
wait for another run. A production worker needs per-row failure handling and backoff. The dispatcher
uses `operationId` as an idempotency key, while its captured transport keeps delivered IDs in memory
only to simulate an idempotent external receiver during the crash-and-retry test. A production
receiver must persist idempotency keys across restarts, and its worker must coordinate concurrent
claims (for example with row locking or a lease); the in-memory set and sample dispatcher do not
provide those production guarantees.
