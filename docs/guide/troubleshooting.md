# Troubleshooting

Start with the error code and the part of the integration that produced it. Package error codes,
HTTP status mappings, and committed-failure behavior are listed in the [error reference](../reference/errors.md).

## Setup cannot apply a change

Review the [setup guide](setup.md) and [setup choices reference](../reference/setup-choices.md). Setup
reports conflicts instead of overwriting application-owned edits. Resolve the reported files in the
application, then run setup again.

## A managed route returns an unexpected response

Check that the route capability is enabled and that the selected authentication guard matches the
application. The [managed HTTP guide](managed-http.md) describes route behavior and the
[endpoint reference](../reference/endpoints.md) lists each route and its access requirements.

## A service operation fails

Check that the capability is enabled in setup and that the adapter uses the expected schema. The
[usage guide](usage.md) documents operation inputs and errors; [compatibility](../reference/compatibility.md)
records supported database and integration versions.

## A notification fails after a request

Some failures happen after the database change has committed. Follow the recovery steps in
[operations](operations.md#recover-from-committed-notification-or-observer-failures), and do not
repeat signup, invitation acceptance, or another operation that already committed.
