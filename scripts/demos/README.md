# Feature recordings

These scripts make the terminal recordings in `docs/assets/demos/`, shown on
[See it run](../../docs/recordings.md) and the feature pages.

```sh
pnpm demos
```

It runs three steps, which can also be run alone:

1. `create_app.mjs tmp/demo-app` builds and packs this checkout, creates a new AdonisJS API app
   with `create-adonisjs@3.4.0`, installs the tarball and the limiter, and copies `overlay/` in:
   every capability except social sign-in, managed routes under `/api`, emails printed to the log.
2. `record.mjs tmp/demo-app tmp/demo-casts [scenario ...]` runs each scenario with real `curl`
   and `node ace` commands and writes one asciicast v2 file per scenario. Each scenario starts
   from `migration:fresh`, which also empties the limiter store. It needs port 3333 free.
3. `render.mjs tmp/demo-casts docs/assets/demos` converts the casts to SVG with
   `svg-term-cli@2.1.1`.

The setup recording uses its own starter app, because setup needs an app without the overlay:

```sh
pnpm demos:setup
```

`create_setup_app.mjs tmp/setup-demo-app` creates the same API starter with Mail, the limiter and
TypeScript, registers the Account Kit commands in `adonisrc.ts`, adds an application-owned
`canAccess` policy, copies `docs/setup_choices.api.example.json` in as `choices.json` and commits
the result. `record_setup.mjs tmp/setup-demo-app tmp/setup-demo-casts` resets the app to that
commit, previews and applies the choices, and writes `setup.cast`; it can be run again.

Remove `tmp/demo-app` or `tmp/setup-demo-app` before running `pnpm demos` or `pnpm demos:setup`
again; the create scripts refuse an existing directory. Tokens, ids and times differ on every run.
