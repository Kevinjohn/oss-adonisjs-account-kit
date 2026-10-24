# Audit log

For operations that publish lifecycle events, `onLifecycleEvent` receives a typed event after the
account transaction commits. Write them to an audit table:

```ts
// config/account_kit.ts
import db from '@adonisjs/lucid/services/db'

onLifecycleEvent: async (event) => {
  await db.table('audit_events').insert({
    type: event.type,
    user_id: 'userId' in event ? event.userId : null,
    invitation_id: 'invitationId' in event ? event.invitationId : null,
    operation_id: event.operationId,
    count: 'count' in event ? event.count : null,
    source: 'source' in event ? event.source ?? null : null,
    created_at: new Date(),
  })
},
```

`onLifecycleEvent` receives these events:

| Type                                                                                                                                                                                                                                      | Fields                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `registration.created`, `verification.completed`, `password_reset.requested`, `password.reset`, `password.changed`, `email_change.requested`, `email_change.completed`, `magic_link.requested`, `sessions.revoked_all`, `account.deleted` | `userId`, `operationId`; optional `source: 'operator'`       |
| `sessions.revoked`                                                                                                                                                                                                                        | `userId`, `operationId`, `count`                             |
| `invitation.sent`, `invitation.resent`, `invitation.revoked`                                                                                                                                                                              | `invitationId`, `operationId`; optional `source: 'operator'` |
| `invitation.accepted` (a link, social account or activation for an invited address)                                                                                                                                                       | `invitationId`, `userId`, `operationId`                      |

Events carry IDs, an optional count and an optional operator marker, never email addresses, tokens
or passwords. The `account.deleted` event's `userId` refers to the account that has already been
deleted.

## Delivery

`onLifecycleEvent` is an awaited observer after the account transaction commits. A database insert
in this callback can persist an observed event, but it is not part of the account transaction: if
the insert fails, the account change still stands and the event is not retried. The operation
reports `PostCommitError` with `committed: true`. This hook is not a persisted queue and does not
provide delivery or retention guarantees.

For a durable application-owned outbox, record its intent in the same transaction as the state
change where a transaction callback is available, then process it with an application worker. The
credential hook can do that for these operations:

```ts
onCredentialsChangedTransaction: async (user, context, trx) => {
  await trx.table('application_audit_outbox').insert({
    type: context.operation,
    user_id: user.id,
    operation_id: context.operationId,
    created_at: new Date(),
  })
},
```

`onCredentialsChangedTransaction` runs inside the operation transaction for `password_reset`,
`password_change`, `email_change`, `access_restriction`, `registration_claim`, `social_unlink` and
`sign_out_everywhere`. It does not capture every lifecycle event. `onPasswordResetIssuedTransaction`
can record password-reset link issuance in its transaction, `onInvitationAccepted` can record
invitation acceptance in its transaction, and `onSessionsRevokedTransaction` can record
`sessions.revoke` and `revokeOthers` with the revoked sign-in ids; each covers only that operation. For other event types,
use an application-owned integration at the relevant transaction boundary if persisted capture is
required. A worker may retry delivery, so the application must make duplicate processing safe; the
package does not promise exactly-once delivery.

For account deletion, `onAccountDeletingTransaction(user, trx)` can persist an application-owned
deletion intent in the deletion transaction; `account.deleted` remains a post-commit event. See
[Account export and deletion](../account-data.md#account-export-and-deletion).

## Further reading

- [Usage: transactions and callbacks](../usage.md#transactions-and-callbacks)
- [Admission events](../admission.md) use the separate `onAdmissionEvent` callback.
