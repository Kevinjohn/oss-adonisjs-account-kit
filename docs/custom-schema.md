# Custom user table or ID type

For a new installation with a non-default table or key type, pass configure options, for example:

```sh
pnpm exec node ace configure adonisjs-account-kit --users-table=account_users --user-id-type=uuid
```

Supported ID types are `integer`, `string`, and `uuid`. Configure uses these values only when it
creates migration files. If recognized files already exist, they remain unchanged and must be
reviewed manually. Point `defineConfig` at `usersTable` for a custom adapter; the Lucid adapter
derives its table, so do not also set `usersTable` for it. The Lucid model must use physical `id` as
its primary-key column and the default connection. For application-assigned string or UUID keys,
set `static selfAssignPrimaryKey = true` and assign the key before insertion. Without that model
policy, SQLite can replace the in-memory key with its numeric rowid and subsequent refreshes fail.
The API fixture selects this policy for its string/UUID modes.

When changing an existing database, inspect foreign-key types and all migration references. Match
`user_id` and `inviter_id` columns to the actual user ID type. Ensure the email unique index covers
only the email column. PostgreSQL duplicate-email classification discovers the single-column email
unique index from the catalog. Set `emailConstraint` only when you need to select a particular
constraint/index explicitly.
