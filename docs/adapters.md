# Users adapters

Account Kit reads and writes users through a `UsersAdapter`. Four ship with the package:

| Import                                  | Use it when                                    |
| --------------------------------------- | ---------------------------------------------- |
| `adonisjs-account-kit/adapters/lucid`   | Users are a Lucid model.                       |
| `adonisjs-account-kit/adapters/drizzle` | The users table is defined with Drizzle.       |
| `adonisjs-account-kit/adapters/prisma`  | The users table is defined with Prisma.        |
| `adonisjs-account-kit/adapters/sql`     | Any other users table on the Lucid connection. |

For anything else, write your own: see [custom adapter](recipes/custom-adapter.md).

## The transaction constraint

Account Kit runs every operation in its own Lucid transaction and locks the user row through it.
The Drizzle and Prisma adapters therefore read only your table definition. Every query runs
through Lucid, on the same database Lucid is connected to. Drizzle and Prisma do not need a
connection of their own for Account Kit, and their clients are never called.

As a result, ORM runtime behaviour does not run for rows Account Kit writes:

- Drizzle `$defaultFn` and `$onUpdate`.
- Prisma `@default(cuid())`, `@default(uuid())` and `@updatedAt`.

Use database defaults instead (`DEFAULT CURRENT_TIMESTAMP`, `gen_random_uuid()`), or pass
`generateId` for string keys that have no database default.

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

`@@map` and `@map` are honoured. Lucid must connect to the same database as Prisma.

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

`mapRegistrationData(data, context)` validates untrusted registration data and returns extra
columns to write, keyed by physical column name. `context` is `{ operation: 'create' }` or
`{ operation: 'update', id }`.

```ts
createDrizzleAdapter(users, {
  mapRegistrationData: async (data) => {
    const { fullName } = await registrationValidator.validate(data)
    return { full_name: fullName }
  },
})
```

It may not set `id`, `email`, `unverified_email`, `password`, `email_verified_at`,
`credentials_changed_at` or `role`, and every key must be a plain SQL identifier. Either throws.

## Proving an adapter

`adonisjs-account-kit/testing/adapter_contract` runs the behaviour checks every shipped adapter
passes, including rollback of each write. Run it against your adapter and database in your test
suite; see [custom adapter](recipes/custom-adapter.md).
