# Account Kit examples

These reference applications show how an AdonisJS app can own its account routes, validation,
authorization, and user-facing messages while using Account Kit for account operations. Read the
[example acceptance contract](../docs/guides/example-acceptance.md) before using their checks as
evidence for an application.

| Example                                      | Stack                                                | Start here                                            |
| -------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| [API](api/README.md)                         | AdonisJS 7, Lucid, JSON routes, opaque access tokens | [`Build one account API`](../docs/guides/core-api.md) |
| [Inertia and React](inertia-react/README.md) | AdonisJS 7, Inertia, React, browser sessions         | [The example README](inertia-react/README.md#run-it)  |

## Package availability

The current package manifest has version `0.0.0`, and there is no matching public npm release and
source tag for these examples yet. Their normal published-package install path is therefore
unavailable. The example READMEs describe the local archive workflow for contributors separately;
it builds Account Kit from this checkout and is not a published consumer install.

When a matching package release and repository tag are available, use the exact package version
and example revision recorded by that release. The normal consumer setup must not build Account Kit
from repository source. Until then, do not treat the local archive path as release-pinned consumer
evidence.

Both applications use development notification fixtures. They do not prove SMTP delivery or
arrival in a recipient inbox. The acceptance contract records the HTTP, browser, and manual checks
for each example and the limits of that evidence.
