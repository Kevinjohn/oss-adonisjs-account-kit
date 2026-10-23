# Account Kit examples

These reference applications show how an AdonisJS app can own its account routes, validation,
authorization, and user-facing messages while using Account Kit for account operations. Read the
[example acceptance contract](../docs/guides/example-acceptance.md) before using their checks as
evidence for an application.

| Example                                      | Stack                                                | Start here                                                       |
| -------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| [API](api/README.md)                         | AdonisJS 7, Lucid, JSON routes, opaque access tokens | [`Build one account API`](../docs/guides/core-api.md)            |
| [Inertia and React](inertia-react/README.md) | AdonisJS 7, Inertia, React, browser sessions         | [The example README](inertia-react/README.md#run-it)             |
| [Inertia and Vue](inertia-vue/README.md)     | AdonisJS 7, Inertia, Vue, browser sessions           | [The example README](inertia-vue/README.md#requirements-and-run) |
| [Hypermedia and Edge](hypermedia/README.md)  | AdonisJS 7, native forms, Edge, database sessions    | [The example README](hypermedia/README.md#install-and-run)       |

## Package availability

Account Kit is available as a GitHub release archive; follow the [root install instructions](../README.md#install).
npm publication is still pending. Use the package version and example revision recorded by the
release when checking a released consumer.

The example READMEs also describe the local archive workflow for contributors. It builds the
current checkout and does not establish release-pinned consumer evidence.

## Contributor smoke record

On 2026-10-21, the API and React examples were installed and exercised from a clean local example setup with
Node.js 24.21.0, pnpm 11.23.0, and SQLite. The local archives contain package version `0.0.0`, built
from source revision `760ec5f5715cad71aba6e326fdbf8885f7cf65ab`; both have SHA-512
`9d3b2d53af46d869686a7dc630f2dea06ab1134edc39d6b54dd3b08cfff5df9830a31c47ceb82690c309b3c208386dced417da21066e4629d76d02bd7571a341`.

From the repository root, both runs started with:

```sh
pnpm install --frozen-lockfile
pnpm build
```

The API archive and clean example setup were:

```sh
pnpm pack --out examples/api/vendor/adonisjs-account-kit.tgz
cd examples/api
pnpm install
cp .env.example .env
node ace generate:key
node ace codegen
node ace migration:run
pnpm dev
```

The React run used the same setup sequence with `pnpm pack --out examples/inertia-react/vendor/adonisjs-account-kit.tgz`
and `cd examples/inertia-react`.

The API smoke received 200 from `GET /`, signed up over HTTP, followed the development proof link,
completed email verification with a password, signed in, and received 200 from the bearer-protected
profile route. The React browser smoke signed up, followed its development proof link, confirmed the
address and set a password, signed in, opened the dashboard and password settings, changed the
password, logged out, and signed in again with the changed password. Its password-change request
redirected with 302 and the settings page returned 200. These runs used a local `example.test`
address and development notification logging; they did not use an OAuth provider or deliver email
to a recipient inbox.

Verification included root `pnpm build`; API `pnpm format:check`, `pnpm lint`, and `pnpm typecheck`;
and API `pnpm test --files=tests/unit/account_kit_notifications.spec.ts` (2 passed). The API lint
reported one existing unused-disable warning in `app/controllers/social_auth_controller.ts`.
React formatting passed with `pnpm exec prettier --check .` from `examples/inertia-react`.

This is contributor-path evidence from a full checkout. It does not replace extracting an isolated
consumer app and completing a clean frozen install against the exact published package version and
matching source release revision. The dated smoke record does not establish that release-pinned
consumer validation; do not treat the local archive or smoke runs as a published-release acceptance.

These API and React runs use development notification fixtures. They do not prove SMTP delivery or
arrival in a recipient inbox. The acceptance contract records the HTTP, browser, and manual checks
for each example and the limits of that evidence.

Vue and Edge have separate [Vue](inertia-vue/README.md#checks-and-evidence) and
[Edge](hypermedia/README.md#checks-and-evidence) source, archive and execution records. Their
verification is not inherited from the API/React smoke above. Use the
[stack and starting-point selector](../docs/guides/adoption-paths.md) for a new or existing app.
