# Users adapters

Account Kit reads and writes users through a `UsersAdapter`. Four ship with the package:

| Import                                  | Use it when                                    |
| --------------------------------------- | ---------------------------------------------- |
| `adonisjs-account-kit/adapters/lucid`   | Users are a Lucid model.                       |
| `adonisjs-account-kit/adapters/drizzle` | The users table is defined with Drizzle.       |
| `adonisjs-account-kit/adapters/prisma`  | The users table is defined with Prisma.        |
| `adonisjs-account-kit/adapters/sql`     | Any other users table on the Lucid connection. |

For anything else, write your own: see [custom adapter](recipes/custom-adapter.md).

## Which one to use

Most AdonisJS apps define users as a Lucid model, and the Lucid adapter is the default. Use another
adapter when your users table is already described somewhere else and you do not want a second
description of it to keep in step.

- **[Drizzle](https://orm.drizzle.team)** is a TypeScript ORM where you write tables as code
  (`pgTable('users', { ... })`) and query them with a typed, SQL-like API. Use the Drizzle adapter
  when your app, or another service sharing the database, already uses Drizzle and its schema file
  is the source of truth for the users table. Account Kit reads the column names from that file.
- **[Prisma](https://www.prisma.io)** is an ORM where you describe models in a `schema.prisma` file
  and Prisma generates a typed client and migrations from it. Use the Prisma adapter when the users
  table is managed by Prisma, for example because the app moved to AdonisJS from another Node
  framework, or because a separate service owns the schema. Account Kit reads the model, including
  `@map` and `@@map` renames, from the generated client.
- **Plain SQL** needs no model at all: you give it the table name. Use it when the users table
  belongs to a legacy database or another system, when you want account queries without model
  hooks, or when you would rather not add a model class just for Account Kit.

Whichever you pick, Account Kit still runs its queries through Lucid, so Lucid must be installed
and connected to the same database. Drizzle and Prisma only supply the table description; their
clients are never called. The section below explains why.

## The transaction constraint

Account Kit runs every operation in its own Lucid transaction and locks the user row through it.
The Drizzle and Prisma adapters therefore read only your table definition. Every query runs
through Lucid, on the same database Lucid is connected to. Drizzle and Prisma do not need a
connection of their own for Account Kit, and their clients are never called.

As a result, ORM runtime behavior does not run for rows Account Kit writes:

- Drizzle `$defaultFn` and `$onUpdate`.
- Prisma `@default(cuid())`, `@default(uuid())` and `@updatedAt`.

Use database defaults instead (`DEFAULT CURRENT_TIMESTAMP`, `gen_random_uuid()`), or pass
`generateId` for string keys that have no database default.

### Hashing before the transaction

A password hash takes 100 to 300 ms. Hashed inside the write transaction, it holds that
transaction open; on SQLite that blocks every other write in the application. An adapter that
implements the optional `hashPassword(password)` and `setPasswordHash(id, hash, trx)` avoids
this. Account Kit then hashes each new password before it opens the transaction. Sign-up,
invitation acceptance, activation with a password, password reset and password change all do
this. The hash goes to `create` as `passwordHash`, with `password` null, or to
`setPasswordHash`. Store it as is; never hash it again. Without `hashPassword`, nothing changes:
`create` and `setPassword` receive the plain password. `defineConfig` refuses `hashPassword`
without `setPasswordHash`.

The Lucid, SQL, Drizzle and Prisma adapters implement both methods with their `hashPassword`
option. The Lucid adapter writes the hash with a query, so the model's hashing hook does not run
on it. When it is given `verifyPassword` alone, it leaves both methods out and the model hook
hashes inside the transaction, as before. Two trade-offs: a sign-up with an address that is already
registered now hashes before it is refused, and completing a password reset or an activation hashes
before the token is checked, so a request with a bogus token also costs a hash. Account Kit does
not throttle those completions; throttle the routes that call them, for example with
`@adonisjs/limiter`.

## Required columns

The users table must have these physical columns:

| Column              | Type                                                        |
| ------------------- | ----------------------------------------------------------- |
| `id`                | Primary key: integer or string                              |
| `email`             | Unique, stored lower-case                                   |
| `unverified_email`  | Nullable text                                               |
| `password`          | Nullable text: the password hash                            |
| `email_verified_at` | Nullable timestamp; text on SQLite, `TIMESTAMP(3)` on MySQL |

Drizzle and Prisma must map the properties `id`, `email`, `unverifiedEmail`, `password` and
`emailVerifiedAt` to those columns. The adapters check this on first use and throw a message that
names the property.

Timestamps are written as ISO 8601 UTC strings and read back as UTC Luxon `DateTime`s. On SQLite,
store `email_verified_at` as text; Drizzle integer-mode timestamps are rejected.

## Drizzle

```ts
// database/schema.ts
import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  unverifiedEmail: text('unverified_email'),
  password: text('password'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'string' }),
  fullName: text('full_name'),
})
```

```ts
// config/account_kit.ts
import { createDrizzleAdapter } from 'adonisjs-account-kit/adapters/drizzle'
import { users } from '../database/schema.js'

export default defineConfig({
  users: createDrizzleAdapter(users),
  // ...
})
```

The table must be in the default schema.

## Prisma

Pass the model from the generated client's DMMF:

```prisma
model User {
  id              Int       @id @default(autoincrement())
  email           String    @unique
  unverifiedEmail String?   @map("unverified_email")
  password        String?
  emailVerifiedAt DateTime? @map("email_verified_at")
  fullName        String?   @map("full_name")

  @@map("users")
}
```

```ts
import { Prisma } from '@prisma/client'
import { createPrismaAdapter } from 'adonisjs-account-kit/adapters/prisma'

const userModel = Prisma.dmmf.datamodel.models.find((model) => model.name === 'User')!

export default defineConfig({
  users: createPrismaAdapter(userModel),
  // ...
})
```

`@@map` and `@map` are honored. Lucid must connect to the same database as Prisma.

## Plain SQL

```ts
import { createSqlUsersAdapter } from 'adonisjs-account-kit/adapters/sql'

export default defineConfig({
  users: createSqlUsersAdapter({ table: 'users' }),
  // ...
})
```

## Options

All three take the same options; `createSqlUsersAdapter` also takes `table`.

| Option                | Default                                                    |
| --------------------- | ---------------------------------------------------------- |
| `db`                  | The application's `@adonisjs/lucid/services/db`            |
| `hashPassword`        | The AdonisJS hash service: `hash.make`                     |
| `verifyPassword`      | The AdonisJS hash service: `hash.verify`                   |
| `mapRegistrationData` | None: registration data is refused                         |
| `generateId`          | None: the database assigns the id                          |
| `emailConstraint`     | None: the unique email constraint name, if not the default |

The adapters hash passwords themselves; there is no model hook to do it. They implement
`delete`, so [account deletion](account-data.md) works with them.

### Registration data

`registration.mapFields(input)` is responsible for selecting and validating application fields
before they reach an adapter. The adapter's `mapRegistrationData(data, context)` receives that
trusted result and maps it to extra columns to write, keyed by physical column name. It is a
persistence mapping, not request validation or field-error handling. `context` is
`{ operation: 'create' }` or `{ operation: 'update', id }`.

```ts
createDrizzleAdapter(users, {
  mapRegistrationData(data) {
    const { fullName } = data as { fullName: string }
    return { full_name: fullName }
  },
})
```

Use the same `fullName` returned by `registration.mapFields` in the [registration guide](registration.md).
The adapter still rejects protected columns such as `id`, `email`, `unverified_email`, `password`,
`email_verified_at`, `credentials_changed_at` and `role`; every returned key must be a plain SQL
identifier. These checks protect persistence and are not a substitute for the application's normal
input-validation and field-error path.

## Proving an adapter

`adonisjs-account-kit/testing/adapter_contract` runs the behavior checks every shipped adapter
passes, including rollback of each write. Run it against your adapter and database in your test
suite; see [custom adapter](recipes/custom-adapter.md).
