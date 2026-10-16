# Operations

## Limiter secret and budgets

Set `limiterSecret` to a stable secret of at least 32 bytes, normally the application's `APP_KEY`.
Account Kit derives HMAC-based keys with the configured `limiterNamespace` (default `default`) so
raw addresses, IPs, and identifiers are not used as limiter keys. Instances sharing a limiter store
must use the same secret and namespace. Rotating the secret changes derived keys and resets the
associated budgets; plan the rotation as a limiter reset.

The general request throttle defaults to five requests per 15 minutes. Invitation budgets default
to 10 sends per actor per hour, 3 sends per recipient per hour, 10 resends per actor per hour, and
3 resends per invitation per hour. Override individual budgets with `throttle` and
`invitationThrottle` in config. Keep budgets consistent across instances sharing limiter storage.

Password reset issuance is limited by both client key and normalized email. When a request is throttled,
the existing unexpired password reset link remains redeemable; the next successful issuance replaces it.
Use a client key derived from the request IP only behind correctly configured trusted proxies, and
do not trust arbitrary forwarded-IP headers. See [password reset and invitation rules](usage.md#a-reset-link-works-once-then-expires).

## Expired-row pruning

The explicit `account-kit:prune` Ace command removes expired password reset, invitation, and
email-verification proofs (activation and email change) in bounded batches. It is not scheduled
automatically. Defaults are 100 rows per batch and at most 100 batches; each setting accepts a
value from 1 through 1000. Use the command's
dry-run option to estimate eligible rows before deletion, then schedule it through the application's
own maintenance mechanism if needed.

The command captures one expiry cutoff for the run, selects IDs in bounded batches, and rechecks
that each row is still expired at deletion time. Counts report rows actually deleted (or rows
eligible in dry-run mode). It does not delete users, access tokens, web sessions, team memberships,
or application-owned records.

Run `pnpm exec node ace account-kit:prune --help` in the configured application to see the
installed command options.

## Durable notifications

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

## Session and membership lifecycle

The package does not universally terminate browser sessions or alter team memberships. Applications
can revoke their own API tokens in `onCredentialsChangedTransaction`. Browser-session termination,
tenant membership cleanup, and other application-specific identity policy remain application
responsibilities.
