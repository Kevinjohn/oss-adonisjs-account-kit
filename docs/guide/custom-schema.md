# Custom user table or ID type

For a new installation with a non-default table or key type, pass configure options, for example:

```sh
pnpm exec node ace configure @kevinjohn/adonisjs-account-kit --users-table=account_users --user-id-type=uuid
```

Supported ID types are `integer`, `string`, and `uuid`. Configure uses these values only when it
creates migration files. If recognized files already exist, they remain unchanged and must be
reviewed manually. Point `defineConfig` at `usersTable` for a custom adapter; the Lucid adapter
derives its table, so do not also set `usersTable` for it. The Lucid model must use physical `id` as
its primary-key column and the default connection. For application-assigned string or UUID keys,
set `static selfAssignPrimaryKey = true` and assign the key before insertion. Without that model
policy, SQLite can replace the in-memory key with its numeric rowid and subsequent refreshes fail.
The repository's consumer harness selects this policy for its string and UUID runs of the
[API example](../../examples/api/README.md#schema), which itself uses the default integer IDs.

For the complete Lucid flow, run configure with the table and ID type before the first migration.
Configure writes only the package migrations; your own users migration, the model's `static table`
and the key policy above, and any application migration that references users are yours to write
for that table and ID type. Then run `migration:run` and `schema:generate`, and point
`app/models/user.ts` at the generated user schema class. The example's optional-name migration
preserves existing names; rollback stops with an actionable error while any user has a null
`full_name`, so assign names before rolling it back.

When changing an existing database, inspect foreign-key types and all migration references. Match
`user_id` and `inviter_id` columns to the actual user ID type. Ensure the email unique index covers
only the email column. PostgreSQL duplicate-email classification discovers the single-column email
unique index from the catalog. Set `emailConstraint` only when you need to select a particular
constraint/index explicitly.
