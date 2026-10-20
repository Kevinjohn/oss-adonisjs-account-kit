# Production boundaries

What Account Kit guarantees in production, and what stays with the application: readiness
evidence, route certification, notification delivery and credential lifecycle. For the procedures,
see [operations](operations.md).

## Readiness and route inspection

Treat setup readiness fields as separate evidence. `configurationValid` can be true while
`migrationsApplied`, `workflowVerified`, and `productionReady` are false; an `externalConfigured`
result is a static plan assessment, not a successful live transport or provider check. Apply
migrations separately, then verify real external integrations and account workflows in the target
environment before declaring the deployment ready. Presence of application-owned policy or
notification files does not establish their callback contracts or delivery behavior; keep those
checks unresolved until the selected flows are exercised against the running application.

Setup route inspection reads literal routes in `start/routes.ts`; it does not boot the application.
Grouped, imported, or programmatically generated routes require the package's committed Adonis
route-graph check during application boot, followed by exercising the selected endpoints. A passing
static `configurationValid` result does not certify that runtime route graph or set
`workflowVerified` or `productionReady`.

## Background work

Account Kit has no required background worker. If the application uses an outbox for durable
notifications, the application must run and monitor its own dispatcher. The example outbox is an
illustration only: its in-memory receiver deduplication and simple dispatcher do not provide
production durability, backoff, or coordinated claims. Network delivery from a notification
callback happens after the account transaction commits but still affects the calling operation;
enqueue quickly when delivery must survive process restarts. The maintained AdonisJS Mail callbacks
use `sendLater`; their default delivery classification is `best-effort` and does not provide retries
or a durable outbox. Queue acceptance does not prove recipient delivery. `delivery: 'durable'` is
only an application-owned claim supported by its verified worker, retry, terminal-failure, action
link, and security-notice handling. See [notifications](notifications.md) for those limits and
the Mail integration contract.

### Durable notifications

Callbacks in `notify` are post-commit. Enqueue work quickly rather than performing a slow network
delivery inline. If reliable delivery across process restarts is required, write an application
outbox row from `onCredentialsChangedTransaction` or another operation-specific transaction hook,
then have an application-owned worker claim and deliver outbox records. Make delivery idempotent
using the supplied `operationId` where available. The example application's outbox illustrates the
application-owned boundary; it is not a package-managed worker or delivery guarantee. Its durable
notice recipe covers password reset/change only. The example still attempts the email-change
security notice to the previous address after commit; that notice is best-effort. To make it
durable, an application must capture the previous recipient inside the email-update transaction
and persist a distinct notice intent. The captured test transport simulates an idempotent receiver;
production delivery requires durable receiver deduplication and coordinated worker claims.

If a post-commit callback fails, the operation may already have committed. `PostCommitError` marks
this with `committed: true`; do not blindly retry the mutation. Password reset request handlers are the
exception: suppress both `DeliveryError` and `PostCommitError` and return the generic accepted
response to preserve account-existence privacy.

### Session, token, and membership lifecycle

Credential-changing Account Kit operations invoke the configured credential-change hook. Use
`onCredentialsChangedTransaction` to update application-owned credentials in the same transaction
when atomic revocation is required; its return path is exclusive with the post-commit
`onCredentialsChanged` hook. The session guard compares the session's credential revision with the
user's current revision. The token guard checks that native authentication's token row remains in
the configured table; credential-changing token operations revoke it by deleting the user's rows in
that table transactionally. Direct database writes bypass these effects. Route account changes
through Account Kit operations or make equivalent application changes to token-row deletion,
session-revision updates, and other application-owned credential state in the same transaction.

The package does not universally terminate browser sessions or alter team memberships. Browser
session-store cleanup, API token policies beyond the configured hook, tenant membership cleanup,
and other application identity rules remain application responsibilities. A notification or
post-commit hook failure can be reported after account state has committed; inspect the error's
committed status and never blindly repeat the account mutation.

Direct writes to `account_admissions` are outside the [admission](admission.md) guarantees: they
skip the subject lock, the transition table and `onAdmissionEvent`. Use the service or the
admission commands.
