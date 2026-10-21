# Add a custom field to profile updates

The Lucid adapter works with your existing `User` model. Account Kit requires its own account and
credential columns; the application owns additional profile fields, their validation, persistence,
and public errors.

## Required columns

| Model property    | Column              | Notes                                                  |
| ----------------- | ------------------- | ------------------------------------------------------ |
| `id`              | `id`                | The physical primary key. Integer, string or UUID.     |
| `email`           | `email`             | Trimmed, lowercase, with a single-column unique index. |
| `password`        | `password`          | Nullable. `null` means no local password.              |
| `unverifiedEmail` | `unverified_email`  | Nullable. Added by the package migrations.             |
| `emailVerifiedAt` | `email_verified_at` | Nullable. Added by the package migrations.             |

Session and token login also use `credentials_changed_at`, added by the migrations. Run
`node ace account-kit:doctor` to confirm the table matches.

## Add one field end to end

This API example adds optional `displayName` to profile updates while preserving the starter's
`fullName` registration field. The source files to adapt are
[`User`](../../examples/api/app/models/user.ts),
[`profileUpdateValidator`](../../examples/api/app/validators/account_kit.ts),
[`ProfileController`](../../examples/api/app/controllers/profile_controller.ts), and
[`account_kit.ts`](../../examples/api/config/account_kit.ts).

Add a nullable `display_name` column in an application migration, then run
`node ace migration:run` to regenerate Lucid's `database/schema.ts`. The generated `UserSchema`
then exposes `displayName` to a `User` model that extends it; do not edit the generated schema by
hand. Keep this application migration separate from Account Kit's package migrations:

```ts
this.schema.alterTable('users', (table) => {
  table.string('display_name', 80).nullable()
})
```

Add the application-owned VineJS rule to the existing profile-update validator. Retain its
optional `email` and `fullName` rules and their existing imports so this change does not remove
profile updates the route already supports:

```ts
export const displayName = () => vine.string().trim().minLength(1).maxLength(80)

export const profileUpdateValidator = vine.create({
  currentPassword: vine.string().minLength(1),
  email: email().optional(),
  fullName: fullName().optional(),
  displayName: displayName().optional(),
})
```

Validate before calling the service, and pass only the accepted field in `registrationData`:

```ts
const { currentPassword, email, fullName, displayName } =
  await ctx.request.validateUsing(profileUpdateValidator)

const updated = await accountKit.emailPasswordManagement.updateProfile({
  actorId: ctx.auth.use('api').getUserOrFail().id,
  currentPassword,
  ...(email === undefined ? {} : { email }),
  ...(fullName === undefined && displayName === undefined
    ? {}
    : {
        registrationData: {
          ...(fullName === undefined ? {} : { fullName }),
          ...(displayName === undefined ? {} : { displayName }),
        },
      }),
})
```

Keep the existing route protected by authentication and the application's current-account policy:

```ts
router
  .patch('/api/v1/account/profile', [ProfileController, 'update'])
  .use(middleware.auth())
  .use(middleware.accountAccess())
```

For browser routes, retain the application's CSRF middleware as well. `accountAccess()` allows a
signed-in but not-yet-verified account to update its profile while still checking current credentials
and application access policy.

Keep the existing `fullName` mapping if the application already accepts it. In the Lucid adapter,
assign only recognized fields that are present; profile updates can supply `displayName` without
resending `fullName`:

```ts
const users = createLucidAdapter(loadUser, {
  mapRegistrationData(data, user) {
    const fields = data as { fullName?: string; displayName?: string }
    if (fields.fullName !== undefined) user.fullName = fields.fullName
    if (fields.displayName !== undefined) user.displayName = fields.displayName
  },
})
```

The service mapper is also used by signup, invitation and social-registration flows. Validate and
allowlist fields at the service boundary, while preserving any existing required signup fields:

```ts
registration: {
  availability: 'open',
  mapFields(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new InvalidInputError('Invalid profile fields')
    const fields = data as Record<string, unknown>
    if (Object.keys(fields).some((key) => !['fullName', 'displayName'].includes(key)))
      throw new InvalidInputError('Invalid profile fields')

    const mapped: { fullName?: string; displayName?: string } = {}
    if (fields.fullName !== undefined) {
      const fullName = registrationFullName(data)
      if (!fullName || fullName.length > 100)
        throw new InvalidInputError('A full name of at most 100 characters is required')
      mapped.fullName = fullName
    }
    const value = fields.displayName
    if (value !== undefined) {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 80)
        throw new InvalidInputError('Invalid display name')
      mapped.displayName = value.trim()
    }
    return mapped
  },
},
```

Import `InvalidInputError` from `adonisjs-account-kit`. Keep the application's signup validator
responsible for requiring its existing `fullName`. The service mapper independently rejects
unrecognized keys and invalid values from non-HTTP callers. The adapter never mass-assigns a
request object; map only fields owned by the application.

## Verify errors and persistence

Run the application migrations in a disposable database. Submit a valid name through the existing
profile route and read it back from the database. Submit a wrong-type value such as
`displayName: 12`; the application's Vine response should identify `displayName` and leave the
stored value unchanged. Call the service mapper with an unexpected key such as `isAdmin` and
confirm it rejects the input. The API starter's request validator strips unknown body properties,
so its HTTP route may accept a valid `displayName` while ignoring an extra `isAdmin`; the service
allowlist remains necessary for other callers. In this supported starter run, blank or overlength
values reached Account Kit's generic invalid-input response rather than Vine's field-specific
error. If field-specific errors for those values are required, map the app's policy errors in its
controller or configure its validator to emit them explicitly.

The reference API's
[profile validator](../../examples/api/app/validators/account_kit.ts),
[profile controller](../../examples/api/app/controllers/profile_controller.ts),
[user model](../../examples/api/app/models/user.ts), and
[registration mapper](../../examples/api/app/services/registration_fields.ts) show the existing
application-owned pattern. The [example acceptance record](../guides/example-acceptance.md)
separates this disposable run from those reference fixtures.

## Hashing and alternate adapters

The Lucid adapter saves passwords through the model, so `withAuthFinder` or your `beforeSave`
hashing runs as usual. Account Kit never writes a plain password to the database. For a different
table or ID type, see [custom user table or ID type](../custom-schema.md). For Drizzle, Prisma or
plain SQL, write an adapter that satisfies the [custom adapter](custom-adapter.md) contract.

## Disposable acceptance

The disposable API app used the repository's `examples/api` reference app at source revision
`ae42132` and was prepared with `pnpm test:consumer -- --database=sqlite --prepare-only`. It ran
Node `v24.21.0`, AdonisJS Core
`7.6.0`, Auth `10.1.0`, Lucid `22.4.2`, Vine `4.4.0`, and Account Kit `0.0.0` against SQLite;
the prepared app uses pnpm `10.21.0` (the packaging workspace uses pnpm `11.23.0`).

The app added nullable `display_name` in a migration and regenerated `database/schema.ts` with
`pnpm exec node ace migration:run --force`. Temporary disposable-app tests named
`recipe_custom_field.spec.ts` and `account_profile_email.spec.ts` passed with
`pnpm exec node ace test --files=recipe_custom_field.spec.ts --files=account_profile_email.spec.ts`;
`CI=true pnpm typecheck` also passed. The custom-field test persisted a trimmed value, returned
a Vine `displayName` field error for wrong-type input without changing storage, ignored an extra
HTTP `isAdmin` property, and the existing email-change test still passed. A second temporary
disposable-app test named `recipe_custom_user_field.spec.ts` passed with
`pnpm exec node ace test --files=recipe_custom_user_field.spec.ts`; it verified direct mapper
rejection for `isAdmin`. Removing the mapper allowlist made that assertion fail, and restoring it
passed. Blank/overlength values reached Account Kit's generic invalid-input response in those runs,
and no signup field was added. See the [example acceptance record](../guides/example-acceptance.md).
