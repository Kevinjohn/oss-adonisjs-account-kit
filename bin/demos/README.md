# Feature recordings

These scripts make the terminal recordings in `docs/assets/demos/`, shown on
[See it run](../../docs/guide/recordings.md) and the feature pages.

```sh
pnpm demos
```

It runs three steps, which can also be run alone:

1. `create_app.ts tmp/demo-app` builds and packs this checkout, creates a new AdonisJS API app
   with `create-adonisjs@3.4.0`, installs the tarball and the limiter, and copies `overlay/` in:
   every capability except social sign-in, managed routes under `/api`, emails printed to the log.
   The producer packs to a unique sibling directory and installs its exact absolute `candidate.tgz`
   path. Keep that archive and `candidate.json` beside the app: the manifest keeps a file dependency
   on those bytes. The JSON records the archive path, package name/version and compressed-byte SHA-256.
2. `record.ts tmp/demo-app tmp/demo-casts [scenario ...]` runs each scenario with real `curl`
   and `node ace` commands and writes one asciicast v2 file per scenario. Each scenario starts
   from `migration:fresh`, which also empties the limiter store. It needs port 3333 free.
3. `render.ts tmp/demo-casts docs/assets/demos` converts each cast to `<stem>.svg` and `<stem>_still.svg` with
   `svg-term-cli@2.1.1`. The animated filename stays unchanged. Both outputs use the same cast,
   terminal dimensions, window decorations and default theme. The still uses `--at` in milliseconds
   at the last nonblank output event (ignoring terminal control sequences and the final empty hold),
   with `--no-cursor`. This captures the completed flow without an animated cursor. Casts without
   visible output fail instead of producing blank previews. Renderer failures stop the command;
   rerun it to regenerate the complete pair after resolving a failure.

The setup recording uses its own starter app, because setup needs an app without the overlay:

```sh
pnpm demos:setup
```

`create_setup_app.ts tmp/setup-demo-app` creates the same API starter with Mail, the limiter and
TypeScript, registers the Account Kit commands in `adonisrc.ts`, adds an application-owned
`canAccess` policy, copies `docs/reference/setup_choices.api.example.json` in as `choices.json` and commits
the result. `record_setup.ts tmp/setup-demo-app tmp/setup-demo-casts` resets the app to that
commit, previews and applies the choices, and writes `setup.cast`; it can be run again.

Remove `tmp/demo-app` or `tmp/setup-demo-app` before running `pnpm demos` or `pnpm demos:setup`
again; the create scripts refuse an existing directory. Tokens, ids and times differ on every run.

The recorders accept only apps created by their matching producer. Each producer writes a role,
canonical root and starter snapshot to `.account-kit-demo.json`. Recording validates the bootstrap,
database configuration and local SQLite path before migrations or reset. Keep this marker intact;
for setup recording it must also match the committed starter copy. Custom apps, modified starter
entrypoints, alternate database configuration and inherited database overrides are rejected.

Feature recording owns the processes it starts, waits for readiness, and attempts bounded cleanup
on failure or interruption. Leave port 3333 free and use disposable local apps: recording resets
their data. Setup recording validates its own Git root before resetting and can repeat from the
same committed starter. Keep proof-bearing casts and logs private until reviewed for publication.
